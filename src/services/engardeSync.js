// Contrôle d'une épreuve engarde-service : engagés, poules puis tableau, importés par le même moteur que
// FencingTimeLive (mêmes verrous, mêmes calculs de points, mêmes notifications). Une épreuve encore vide
// est simplement notée « en attente » : le suivi automatique reviendra jusqu'à la publication.
const E = require('./engardeParser');
const { createEngardeClient } = require('./engardeTournament');
const { applyPool } = require('./ftlPools');
const recompose = require('./poolRecompose');
const { localTime } = require('./localTime');
const { validateManifest } = require('./roundManifest');
const { norm } = require('./ftlParser');
const { failure } = require('./ftlClient');

const linkOf = (config) => ({ org: config.org, event: config.tournamentSlug, compe: config.compe });

// Engagés : pris tels quels à la première publication ; ensuite, tant qu'aucune poule n'a commencé,
// les nouveaux arrivent et les absents passent inactifs (leurs identifiants restent pour les pronostics).
async function refreshRoster(db, c, url, client, html = null) {
  const observed = E.parseRoster(html ?? (await client.get(url)));
  const current = c.podiumRoster || [];
  const byId = new Map(current.map((e) => [e.id, e]));
  const seen = new Set(observed.map((e) => e.id));
  const merged = [
    ...current.map((e) =>
      seen.has(e.id) ? { ...e, ...observed.find((o) => o.id === e.id) } : { ...e, active: false },
    ),
    ...observed.filter((e) => !byId.has(e.id)),
  ].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (c.podiumRoster && JSON.stringify(merged) === JSON.stringify(current) && c.rosterSourceUrl === url) return c;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    const fresh = await tx.competition.findUnique({ where: { id: c.id } });
    if (JSON.stringify(fresh.podiumRoster) !== JSON.stringify(c.podiumRoster))
      throw failure('Liste des engagés modifiée pendant le contrôle.', 409);
    if (fresh.podiumRoster) {
      const started = await tx.poolFencer.count({
        where: { pool: { competitionId: c.id }, OR: [{ firstResultAt: { not: null } }, { wins: { not: null } }] },
      });
      if (started || (await tx.match.count({ where: { competitionId: c.id } }))) {
        // Épreuve commencée : la liste ne change plus, sauf engagé ajouté en retard (nouvel identifiant).
        const known = new Set(fresh.podiumRoster.map((e) => e.id));
        const late = observed.filter((e) => !known.has(e.id));
        if (!late.length) return fresh;
        return tx.competition.update({
          where: { id: c.id },
          data: {
            podiumRoster: [...fresh.podiumRoster, ...late].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
            rosterCheckedAt: new Date(),
          },
        });
      }
    }
    return tx.competition.update({
      where: { id: c.id },
      data: { podiumRoster: merged, rosterSourceUrl: url, rosterCheckedAt: new Date() },
    });
  });
}

async function addLateEntrants(db, c, rows) {
  const current = c.podiumRoster || [];
  const withClubs = current.some((e) => e.country);
  const missing = [];
  for (const r of rows)
    if (!current.some((e) => norm(e.name) === norm(r.name)) && !missing.some((e) => norm(e.name) === norm(r.name)))
      missing.push({
        id: E.entryId(r.name, withClubs ? r.club || '' : ''),
        name: r.name,
        country: withClubs ? r.club || '' : '',
        active: true,
        entryRanking: null,
      });
  if (!missing.length || missing.some((m) => current.some((e) => e.id === m.id))) return;
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    const fresh = await tx.competition.findUnique({ where: { id: c.id } });
    if (JSON.stringify(fresh.podiumRoster) !== JSON.stringify(c.podiumRoster))
      throw failure('Liste des engagés modifiée pendant le contrôle.', 409);
    await tx.auditLog.create({
      data: {
        actorId: 0,
        action: 'Engagés ajoutés depuis les poules',
        targetType: 'Competition',
        targetId: c.id,
        after: { names: missing.map((m) => m.name) },
      },
    });
    return tx.competition.update({
      where: { id: c.id },
      data: {
        podiumRoster: [...fresh.podiumRoster, ...missing].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        rosterCheckedAt: new Date(),
      },
    });
  });
  c.podiumRoster = updated.podiumRoster;
}

function startsAt(config, time) {
  if (!time) return null;
  try {
    return localTime(config.date, time.hour, time.minute, config.timezone);
  } catch {
    return null;
  }
}

async function syncPools(db, c, config, url, client, leaseToken, { provisional = false } = {}) {
  const summary = { checked: 0, locks: 0, finalized: 0, changed: 0, pointsUpdated: 0, warnings: [] };
  let observedAll;
  try {
    observedAll = E.parsePools(await client.get(url));
  } catch (e) {
    summary.warnings.push(e.status ? e.message : 'Poules engarde-service illisibles pour le moment.');
    return summary;
  }
  const inRoster = (name) => (c.podiumRoster || []).filter((e) => norm(e.name) === norm(name)).length === 1;
  // Tireur engagé sur place, présent en poule mais pas (encore) dans la liste publiée : ajouté aux engagés.
  try {
    await addLateEntrants(
      db,
      c,
      observedAll.filter((o) => !o.error).flatMap((o) => o.rows),
    );
  } catch (e) {
    summary.warnings.push(e.status ? e.message : 'Engagés de dernière minute non ajoutés.');
  }
  let pools = await db.pool.findMany({
    where: { competitionId: c.id },
    include: { fencers: { orderBy: { position: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  try {
    for (const o of observedAll) if (!o.error) o.startsAt = startsAt(config, o.time);
    // Une poule illisible ce contrôle-ci n'est ni comparée ni supprimée.
    const unreadable = new Set(observedAll.filter((o) => o.error).map((o) => o.number));
    const plan = recompose.planRecomposition(
      pools.filter((p) => !unreadable.has(p.sourcePoolNumber)),
      url,
      observedAll.filter((o) => !o.error),
      c.podiumRoster,
    );
    if (plan) {
      if (leaseToken) await db.$transaction((tx) => require('./ftlScheduler').assertClaim(tx, c.id, leaseToken));
      const result = await recompose.applyRecomposition(db, c, url, plan, config);
      summary.recomposed = [result];
      summary.notes = [recompose.describe(result)];
      pools = await db.pool.findMany({
        where: { competitionId: c.id },
        include: { fencers: { orderBy: { position: 'asc' } } },
        orderBy: { id: 'asc' },
      });
    }
  } catch (e) {
    summary.warnings.push(e.status ? e.message : 'Recomposition des poules à vérifier.');
  }
  for (const observed of observedAll) {
    try {
      if (observed.error) throw failure(observed.error);
      observed.startsAt = startsAt(config, observed.time);
      observed.closeAtStart = config.timezone === 'Europe/Paris';
      observed.provisional = provisional;
      if (observed.rows.some((r) => !inRoster(r.name)))
        throw failure(`Poule ${observed.number} : tireur absent ou ambigu dans les engagés.`);
      let snapshot = pools.find((p) => p.sourceUrl === url && p.sourcePoolNumber === observed.number);
      if (!snapshot) {
        if (pools.some((p) => p.fencers.some((f) => observed.rows.some((r) => norm(r.name) === norm(f.name)))))
          throw failure(`Poule ${observed.number} déjà présente sans correspondance de source certaine.`);
        snapshot = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
          const duplicate = await tx.pool.findFirst({
            where: { competitionId: c.id, sourceUrl: url, sourcePoolNumber: observed.number },
            include: { fencers: { orderBy: { position: 'asc' } } },
          });
          if (duplicate) return duplicate;
          return tx.pool.create({
            data: {
              competitionId: c.id,
              name: `Poule ${observed.number}`,
              closesAt: new Date(config.date + 'T00:00:00Z'),
              lockMode: 'FIRST_RESULT',
              sourceUrl: url,
              sourcePoolNumber: observed.number,
              fencers: { create: observed.rows.map((r) => ({ name: r.name, position: r.position })) },
            },
            include: { fencers: { orderBy: { position: 'asc' } } },
          });
        });
        pools.push(snapshot);
      }
      const result = await db.$transaction(
        async (tx) => {
          if (leaseToken) await require('./ftlScheduler').assertClaim(tx, c.id, leaseToken);
          return applyPool(tx, snapshot, observed, new Date());
        },
        { timeout: 15000 },
      );
      summary.checked++;
      for (const k of ['locks', 'finalized', 'changed', 'pointsUpdated']) summary[k] += result[k];
      if (observed.ambiguous)
        summary.warnings.push(
          `Poule ${observed.number} : score réciproque manquant ; tireurs concernés verrouillés, bilan incomplet non inventé.`,
        );
    } catch (e) {
      summary.warnings.push(e.status ? e.message : 'Une poule n’a pas pu être importée. Réessayez.');
    }
  }
  return summary;
}

// Manifeste des tours : du premier tour publié jusqu'à la finale (exemptions exclues du premier tour).
function manifest(rounds) {
  const played = rounds.filter((r) => r.expectedMatchCount > 0).sort((a, b) => b.size - a.size);
  if (!played.length) throw failure('Tableau sans rencontre publiée.');
  const first = played[0].size;
  const out = [];
  for (let n = first; n >= 2; n /= 2)
    out.push({
      round: `T${n}`,
      previousRound: n === first ? null : `T${n * 2}`,
      expectedMatchCount: n === first ? played[0].expectedMatchCount : n / 2,
    });
  return validateManifest(out);
}

async function observeTableau(c, config, pages, client) {
  const { podiumFromResults } = require('./ftlSync');
  const htmls = [];
  for (const url of pages.tableaus) htmls.push(await client.get(url));
  const parsed = E.parseTableaus(htmls);
  const entry = (name) => {
    const hits = (c.podiumRoster || []).filter((e) => norm(e.name) === norm(name));
    if (hits.length !== 1) throw failure(`Nom officiel ambigu ou absent des engagés : ${name}.`);
    return hits[0];
  };
  const matches = parsed.matches.map((m) => {
    entry(m.player1);
    entry(m.player2);
    return {
      sourceKey: m.sourceKey,
      round: m.round,
      player1: m.player1,
      player2: m.player2,
      startsAt: startsAt(config, m.time),
      strip: m.strip,
      winner: m.winner,
      score1: m.score1,
      score2: m.score2,
      resultType: m.resultType,
      isFinished: m.isFinished,
    };
  });
  const rounds = manifest(parsed.rounds);
  const warnings = [];
  let officialPodium = null,
    resultsSourceUrl = null;
  if (matches.some((m) => m.round === 'T2' && m.isFinished) && pages.final) {
    try {
      const rows = E.parseFinalRanking(await client.get(pages.final)).map((r) => ({ ...r, id: entry(r.name).id }));
      officialPodium = podiumFromResults(rows, c, matches);
      resultsSourceUrl = pages.final;
    } catch (e) {
      warnings.push(e.status ? e.message : 'Podium non vérifiable pour le moment.');
    }
  }
  return {
    sourceUrl: `${config.eventSourceUrl}/tableau`,
    matches,
    rounds,
    officialPodium,
    resultsSourceUrl,
    warnings,
    checkedAt: new Date(),
  };
}

// Partie propre à engarde-service d'un contrôle ; la suite (résumé, classements, rythme) est commune.
async function control(db, c, config, actorId, claim, client) {
  client ||= createEngardeClient();
  const { planMatches, applyObservation, cancellable, drawSignature } = require('./ftlSync');
  const notes = [];
  const pages = E.competitionPages(await client.get(config.eventSourceUrl), linkOf(config));
  // Tirage publié la veille, avant l'appel : poules provisoires, fermées aux pronostics jusqu'à l'appel
  // (liste « présents ») ou, faute d'appel sur engarde, jusqu'au jour de l'épreuve.
  let provisional = false;
  if (pages.roster) {
    const rosterHtml = await client.get(pages.roster);
    c = await refreshRoster(db, c, pages.roster, client, rosterHtml);
    let dayStart = null;
    try {
      dayStart = localTime(config.date, 0, 0, config.timezone).getTime();
    } catch {
      dayStart = null;
    }
    provisional = !E.rosterCheckedIn(rosterHtml) && dayStart !== null && Date.now() < dayStart;
  }
  const empty = { checked: 0, locks: 0, finalized: 0, changed: 0, pointsUpdated: 0, warnings: [] };
  let summary = {
    createdIds: [],
    created: 0,
    results: 0,
    corrections: 0,
    pointsUpdated: 0,
    podium: false,
    checked: 0,
    checkedAt: new Date().toISOString(),
    warnings: [],
  };
  if (!c.podiumRoster) {
    notes.push('Épreuve pas encore publiée sur engarde-service. Elle sera recherchée au prochain contrôle.');
    return { c, poolSummary: empty, summary: { ...summary, notes } };
  }
  const poolSummary = pages.pools.length
    ? await syncPools(db, c, config, pages.pools[0], client, claim.token, { provisional })
    : { ...empty, notes: ['Poules pas encore publiées.'] };
  const existing = await db.match.findMany({ where: { competitionId: c.id } });
  if (pages.tableaus.length) {
    try {
      let observation = await observeTableau(c, config, pages, client);
      const conflicts = planMatches(existing, observation, { allowPartial: true }).conflicts;
      if (
        conflicts.some((i) =>
          cancellable(
            existing.find((m) => m.id === i.id),
            observation,
          ),
        )
      ) {
        const confirmation = await observeTableau(c, config, pages, client);
        if (drawSignature(observation) !== drawSignature(confirmation))
          throw failure('Le tableau officiel change pendant le contrôle. Nouvelle vérification nécessaire.');
        observation = { ...confirmation, drawConfirmed: true };
      }
      summary = await db.$transaction((tx) => applyObservation(tx, c, observation, actorId, claim.token), {
        timeout: 30000,
        maxWait: 5000,
      });
    } catch (e) {
      if (!poolSummary.checked) throw e;
      summary.warnings.push(e.status ? e.message : 'Tableau non vérifiable pour le moment.');
    }
  } else notes.push('Tableau pas encore publié. Il sera recherché au prochain contrôle.');
  if (notes.length) summary.notes = [...(summary.notes || []), ...notes];
  return { c, poolSummary, summary };
}

module.exports = { control, refreshRoster, observeTableau, manifest, syncPools };
