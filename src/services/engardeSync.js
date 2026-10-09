// Contrôle d'une épreuve engarde-service : engagés, poules puis tableau, importés par le même moteur que
// FencingTimeLive (mêmes verrous, mêmes calculs de points, mêmes notifications). Une épreuve encore vide
// est simplement notée « en attente » : le suivi automatique reviendra jusqu'à la publication.
const E = require('./engardeParser');
const schedule = require('./schedule');
const { createEngardeClient } = require('./engardeTournament');
const { applyPool } = require('./ftlPools');
const recompose = require('./poolRecompose');
const { localTime } = require('./localTime');
const { validateManifest } = require('./roundManifest');
const { norm } = require('./ftlParser');
const { failure } = require('./ftlClient');
const { mergeRoster, entryFor } = require('./engardeRoster');

const linkOf = (config) => ({ org: config.org, event: config.tournamentSlug, compe: config.compe });

// Engagés : pris tels quels à la première publication ; ensuite, tant qu'aucune poule n'a commencé,
// les nouveaux arrivent et les absents passent inactifs (leurs identifiants restent pour les pronostics).
// Engagés : nouveaux ajoutés, absents de la liste marqués inactifs (identifiants conservés pour les
// pronostics), nation et rang mis à jour, noms corrigés suivis sans changer d'identifiant (poules et
// rencontres prennent le nouveau nom).
async function refreshRoster(db, c, url, client, html = null) {
  const observed = E.parseRoster(html ?? (await client.get(url)));
  const current = c.podiumRoster || [];
  let merged, renames;
  try {
    ({ merged, renames } = mergeRoster(current, observed));
  } catch (error) {
    if (error.status !== 409) throw error;
    await require('./identityReview').record(db, c, url, observed);
    throw error;
  }
  if (db.fencerAffiliation) await db.$transaction((tx) => require('./fencerAffiliations').ingest(tx, c, observed, url));
  if (
    !c.identityReview &&
    c.podiumRoster &&
    JSON.stringify(merged) === JSON.stringify(current) &&
    c.rosterSourceUrl === url
  )
    return c;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    const fresh = await tx.competition.findUnique({ where: { id: c.id } });
    if (
      JSON.stringify(fresh.podiumRoster) !== JSON.stringify(c.podiumRoster) ||
      JSON.stringify(fresh.identityReview) !== JSON.stringify(c.identityReview)
    )
      throw failure('Liste des engagés modifiée pendant le contrôle.', 409);
    for (const r of renames) {
      await tx.poolFencer.updateMany({ where: { name: r.from, pool: { competitionId: c.id } }, data: { name: r.to } });
      await tx.match.updateMany({ where: { competitionId: c.id, player1: r.from }, data: { player1: r.to } });
      await tx.match.updateMany({ where: { competitionId: c.id, player2: r.from }, data: { player2: r.to } });
    }
    if (renames.length)
      await tx.auditLog.create({
        data: {
          actorId: 0,
          action: 'Renommage officiel d’engagés',
          targetType: 'Competition',
          targetId: c.id,
          before: { names: renames.map((r) => ({ id: r.id, name: r.from })) },
          after: { names: renames.map((r) => ({ id: r.id, name: r.to })) },
        },
      });
    return tx.competition.update({
      where: { id: c.id },
      data: {
        podiumRoster: merged,
        rosterSourceUrl: url,
        rosterCheckedAt: new Date(),
        ...(c.identityReview ? { identityReview: require('@prisma/client').Prisma.DbNull } : {}),
      },
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

// engarde n'affiche que l'heure (« 09:00 Piste 3 ») : la date vient de l'épreuve, décalée d'un jour
// à chaque phase qui commence plus tôt que la précédente (épreuve sur plusieurs jours).
function dayOf(config, offset = 0) {
  if (!offset) return config.date;
  return new Date(Date.parse(`${config.date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}
function startsAt(config, time, offset = 0) {
  if (!time) return null;
  try {
    return localTime(dayOf(config, offset), time.hour, time.minute, config.timezone);
  } catch {
    return null;
  }
}
const minutes = (times) => {
  const all = times.filter(Boolean).map((t) => t.hour * 60 + t.minute);
  return all.length ? Math.min(...all) : null;
};
// Phase suivante (tour de poules, tour de tableau) : même jour, ou lendemain si elle commence plus tôt.
function nextDay(prev, min) {
  if (!prev) return { min, offset: 0 };
  if (min === null) return prev;
  return { min, offset: prev.min !== null && min < prev.min ? prev.offset + 1 : prev.offset };
}

async function syncPools(db, c, config, url, client, leaseToken, { provisional = false, round = 1, prev = null } = {}) {
  const summary = { checked: 0, locks: 0, finalized: 0, changed: 0, pointsUpdated: 0, warnings: [], day: prev };
  // Second tour de poules et suivants : « Tour 2 · Poule 3 » (les numéros repartent de 1 à chaque tour).
  const label = (n) => (round > 1 ? `Tour ${round} · Poule ${n}` : `Poule ${n}`);
  let observedAll;
  try {
    observedAll = E.parsePools(await client.get(url));
  } catch (e) {
    summary.warnings.push(e.status ? e.message : 'Poules engarde-service illisibles pour le moment.');
    return summary;
  }
  // Homonymes départagés par la nation ou le club affiché à côté du nom.
  const inRoster = (name, club) => Boolean(entryFor(c.podiumRoster, name, club));
  // Tireur engagé sur place, présent en poule mais pas (encore) dans la liste publiée : ajouté aux engagés.
  try {
    // Un forfait (DNS) n'est jamais ajouté aux engagés.
    await addLateEntrants(
      db,
      c,
      observedAll.filter((o) => !o.error).flatMap((o) => o.rows.filter((r) => !r.absent)),
    );
  } catch (e) {
    summary.warnings.push(e.status ? e.message : 'Engagés de dernière minute non ajoutés.');
  }
  let pools = await db.pool.findMany({
    where: { competitionId: c.id },
    include: { fencers: { orderBy: { position: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  let day = nextDay(prev, minutes(observedAll.filter((o) => !o.error).map((o) => o.time)));
  // Jour du tour corrigé par un administrateur : il fait foi (et sert de repère aux phases suivantes).
  const forced = schedule.phaseDay(config, `pools-${round}`);
  if (forced && config.date) day = { ...day, offset: schedule.daysBetween(config.date, forced) };
  summary.day = day;
  try {
    for (const o of observedAll) if (!o.error) o.startsAt = startsAt(config, o.time, day.offset);
    // Une poule illisible ce contrôle-ci n'est ni comparée ni supprimée.
    const unreadable = new Set(observedAll.filter((o) => o.error).map((o) => o.number));
    const plan = recompose.planRecomposition(
      pools.filter((p) => !unreadable.has(p.sourcePoolNumber)),
      url,
      observedAll.filter((o) => !o.error),
      c.podiumRoster,
      label,
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
      observed.startsAt = startsAt(config, observed.time, day.offset);
      observed.closeAtStart = config.timezone === 'Europe/Paris';
      observed.provisional = provisional;
      if (observed.rows.some((r) => !r.absent && !inRoster(r.name, r.club)))
        throw failure(`${label(observed.number)} : tireur absent ou ambigu dans les engagés.`);
      let snapshot = pools.find((p) => p.sourceUrl === url && p.sourcePoolNumber === observed.number);
      if (!snapshot) {
        // Les mêmes tireurs figurent normalement dans les poules des autres tours : seules comptent
        // les poules de ce tour et celles saisies à la main.
        if (
          pools.some(
            (p) =>
              (!p.sourceUrl || p.sourceUrl === url) &&
              p.fencers.some((f) => observed.rows.some((r) => norm(r.name) === norm(f.name))),
          )
        )
          throw failure(`${label(observed.number)} déjà présente sans correspondance de source certaine.`);
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
              name: label(observed.number),
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
      // Tireurs sortis de la compétition (forfait, abandon, exclusion) : alerte podium plus bas.
      for (const r of observed.rows.filter((x) => x.absent)) {
        const found = entryFor(c.podiumRoster, r.name, r.club);
        if (found) summary.outs = [...(summary.outs || []), { id: found.id, status: r.status || 'DNS' }];
      }
      if (observed.ambiguous)
        summary.warnings.push(
          `${label(observed.number)} : score réciproque manquant ; tireurs concernés verrouillés, bilan incomplet non inventé.`,
        );
    } catch (e) {
      summary.warnings.push(e.status ? e.message : 'Une poule n’a pas pu être importée. Réessayez.');
    }
  }
  return summary;
}

// Manifeste des tours : du premier tour publié jusqu'à la finale (exemptions exclues du premier tour).
function manifest(rounds) {
  const played = rounds.filter((r) => r.round !== 'Bronze' && r.expectedMatchCount > 0).sort((a, b) => b.size - a.size);
  if (!played.length) throw failure('Tableau sans rencontre publiée.');
  const first = played[0].size;
  const out = [];
  for (let n = first; n >= 2; n /= 2)
    out.push({
      round: `T${n}`,
      previousRound: n === first ? null : `T${n * 2}`,
      expectedMatchCount: n === first ? played[0].expectedMatchCount : n / 2,
    });
  // Épreuve par équipes : match pour la 3e place après les demi-finales.
  if (rounds.some((r) => r.round === 'Bronze'))
    out.push({ round: 'Bronze', previousRound: 'T4', expectedMatchCount: 1 });
  return validateManifest(out);
}

async function observeTableau(c, config, pages, client, prev = null) {
  const { podiumFromResults } = require('./ftlSync');
  const htmls = [],
    pageIssues = [];
  for (const url of pages.tableaus) {
    try {
      htmls.push(await client.get(url));
    } catch (error) {
      if (!error.status) throw error;
      pageIssues.push({ message: `${url} : ${error.message}` });
    }
  }
  const parsed = E.parseTableaus(htmls, { allowPartial: true });
  const entry = (name, club = '') => {
    const found = entryFor(c.podiumRoster, name, club);
    if (!found) throw failure(`Nom officiel ambigu ou absent des engagés : ${name}.`);
    return found;
  };
  // Jour de chaque tour : à la suite des poules, lendemain quand un tour commence plus tôt que le précédent.
  const offsets = new Map();
  let day = prev;
  for (const r of [...parsed.rounds].sort((a, b) => b.size - a.size)) {
    day = nextDay(day, minutes(parsed.matches.filter((m) => m.round === r.round).map((m) => m.time)));
    const forced = schedule.phaseDay(config, r.round);
    if (forced && config.date) day = { ...day, offset: schedule.daysBetween(config.date, forced) };
    offsets.set(r.round, day.offset);
  }
  const identityIssues = [];
  const matches = parsed.matches.flatMap((m) => {
    try {
      // Forfait (DNS) au tableau : le perdant peut ne plus figurer dans la liste des présents.
      const walkoverLoser = m.isFinished && m.resultType === 'MEDICAL_WITHDRAWAL' ? 3 - m.winner : null;
      if (walkoverLoser !== 1) entry(m.player1, m.club1);
      if (walkoverLoser !== 2) entry(m.player2, m.club2);
      return {
        pointsPending: Boolean(m.pointsPending),
        syncIssue: m.syncIssue || null,
        sourceKey: m.sourceKey,
        round: m.round,
        player1: m.player1,
        player2: m.player2,
        seed1: m.seed1,
        seed2: m.seed2,
        startsAt: startsAt(config, m.time, offsets.get(m.round) || 0),
        strip: m.strip,
        winner: m.winner,
        score1: m.score1,
        score2: m.score2,
        resultType: m.resultType,
        isFinished: m.isFinished,
      };
    } catch (error) {
      if (!error.status) throw error;
      identityIssues.push({
        sourceKey: m.sourceKey,
        round: m.round,
        message: `${m.round} · ${m.sourceKey} : ${error.message}`,
      });
      return [];
    }
  });
  const rounds = manifest(parsed.rounds);
  const issues = [...pageIssues, ...(parsed.issues || []), ...identityIssues];
  const warnings = issues.map((i) => i.message);
  let officialPodium = null,
    resultsSourceUrl = null;
  if (matches.some((m) => m.round === 'T2' && m.isFinished) && pages.final) {
    try {
      const rows = E.parseFinalRanking(await client.get(pages.final)).map((r) => ({
        ...r,
        id: entry(r.name, r.club).id,
      }));
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
    issues,
    officialPodium,
    resultsSourceUrl,
    warnings,
    checkedAt: new Date(),
  };
}

// Partie propre à engarde-service d'un contrôle ; la suite (résumé, classements, rythme) est commune.
async function control(db, c, config, actorId, claim, client) {
  const source = client || createEngardeClient();
  // Heure de publication la plus récente lue en pied des pages consultées (affichée aux joueurs).
  let publishedAt = null;
  client = {
    ...source,
    get: async (url) => {
      const html = await source.get(url);
      const at = E.publishedAt(html, config.timezone);
      if (at && (!publishedAt || at > publishedAt)) publishedAt = at;
      return html;
    },
  };
  const { planMatches, applyObservation, cancellable, drawSignature } = require('./ftlSync');
  const notes = [],
    rosterWarnings = [];
  const pages = E.competitionPages(await client.get(config.eventSourceUrl), linkOf(config));
  // Tirage publié la veille, avant l'appel : poules provisoires, fermées aux pronostics jusqu'à l'appel
  // (liste « présents ») ou, faute d'appel sur engarde, jusqu'au jour de l'épreuve.
  let provisional = false;
  if (pages.roster) {
    try {
      const rosterHtml = await client.get(pages.roster);
      c = await refreshRoster(db, c, pages.roster, client, rosterHtml);
      let dayStart = null;
      try {
        dayStart = localTime(config.date, 0, 0, config.timezone).getTime();
      } catch {
        dayStart = null;
      }
      provisional = !E.rosterCheckedIn(rosterHtml) && dayStart !== null && Date.now() < dayStart;
    } catch (error) {
      if (!error.status) throw error;
      rosterWarnings.push(`Liste des engagés : ${error.message} Identités déjà vérifiées conservées.`);
    }
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
  // Tous les tours de poules publiés (poules1.htm, poules2.htm…), dans l'ordre.
  const poolPages = [...pages.pools].sort(
    (a, b) => Number(/poules(\d+)\.htm$/.exec(a)?.[1]) - Number(/poules(\d+)\.htm$/.exec(b)?.[1]),
  );
  let poolSummary = { ...empty, notes: ['Poules pas encore publiées.'] },
    day = null;
  const wasProvisional = await db.pool.count({ where: { competitionId: c.id, lockMode: 'PROVISIONAL' } });
  if (poolPages.length) {
    poolSummary = { ...empty, warnings: [] };
    for (const [i, url] of poolPages.entries()) {
      try {
        const s = await syncPools(db, c, config, url, client, claim.token, { provisional, round: i + 1, prev: day });
        day = s.day;
        for (const k of ['checked', 'locks', 'finalized', 'changed', 'pointsUpdated']) poolSummary[k] += s[k];
        poolSummary.warnings.push(...s.warnings);
        if (s.notes) poolSummary.notes = [...(poolSummary.notes || []), ...s.notes];
        if (s.recomposed) poolSummary.recomposed = [...(poolSummary.recomposed || []), ...s.recomposed];
        if (s.outs) poolSummary.outs = [...(poolSummary.outs || []), ...s.outs];
      } catch (error) {
        if (!error.status) throw error;
        poolSummary.warnings.push(`Tour ${i + 1} de poules : ${error.message}`);
      }
    }
  }
  if (poolSummary.outs?.length) await require('./podiumAlerts').alertPodiumOut(db, c, poolSummary.outs);
  // Tirage provisoire devenu définitif : les joueurs sont prévenus que les pronostics de poules sont ouverts.
  if (wasProvisional && !provisional) {
    const confirmed = await db.pool.findMany({
      where: { competitionId: c.id, isFinal: false, lockMode: { not: 'PROVISIONAL' } },
      select: { id: true },
    });
    if (confirmed.length && !(await db.pool.count({ where: { competitionId: c.id, lockMode: 'PROVISIONAL' } })))
      if (
        await require('./poolRoundAlerts').alertPoolsConfirmed(
          db,
          c,
          confirmed.map((p) => p.id),
        )
      )
        poolSummary.notes = [...(poolSummary.notes || []), 'Poules confirmées : joueurs prévenus.'];
  }
  const existing = await db.match.findMany({ where: { competitionId: c.id } });
  if (pages.tableaus.length) {
    try {
      let observation = await observeTableau(c, config, pages, client, day);
      const conflicts = planMatches(existing, observation, { allowPartial: true }).conflicts;
      if (
        conflicts.some((i) =>
          cancellable(
            existing.find((m) => m.id === i.id),
            observation,
          ),
        )
      ) {
        const confirmation = await observeTableau(c, config, pages, client, day);
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
  summary.warnings.push(...rosterWarnings);
  if (notes.length) summary.notes = [...(summary.notes || []), ...notes];
  if (publishedAt) summary.publishedAt = publishedAt.toISOString();
  return { c, poolSummary, summary };
}

module.exports = { nextDay, dayOf, startsAt, control, refreshRoster, observeTableau, manifest, syncPools };
