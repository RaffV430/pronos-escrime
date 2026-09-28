const { load } = require('cheerio');
const { createClient, failure, ORIGIN } = require('./ftlClient');
const { parseTable, clean, norm } = require('./ftlParser');
const events = require('./ftlEvents');
const { configuration } = require('./ftlConfiguration');
const { parsePools, applyPool, pattern: poolPattern } = require('./ftlPools');
const { captureRankings } = require('./rankingHistory');
const { validateManifest } = require('./roundManifest');
const { calculateMatchPoints } = require('./matchPoints');
const { rescore } = require('./rescore');
const { applyOutsiderBonus } = require('./outsider');
const podiumRules = require('./podiumRules');
const START = 'Contrôle FTL démarré',
  DONE = 'Contrôle FTL terminé',
  FAILED = 'Contrôle FTL échoué';
const COOLDOWN = 120000;
const sourcePattern = /^https:\/\/www\.fencingtimelive\.com\/tableaus\/scores\/([a-f0-9]{32})\/[a-f0-9]{32}$/i;
const samePair = (a, b) => norm(a.player1) === norm(b.player1) && norm(a.player2) === norm(b.player2);
const pairKey = (m) => [norm(m.player1), norm(m.player2)].sort().join('|');
function verifyPage(html, config) {
  const $ = load(html);
  if (
    norm($('.desktop.tournName').text()) !== norm(config.tournament) ||
    norm($('.desktop.eventName').text()) !== norm(config.event) ||
    norm($('.desktop.eventTime').text()) !== norm(config.eventTime)
  )
    throw failure('Identité ou date de l’épreuve officielle différente de la configuration.');
  return $;
}
async function poolMatrices($, url, client) {
  if ($('table.poolTable').length) return $;
  // FTL's pool page publishes placeholders and loads each observed pool ID separately.
  const ids = $('div[id^="pool_"]')
    .toArray()
    .map((el) => $(el).attr('id').slice(5));
  if (
    !ids.length ||
    ids.length > 256 ||
    ids.some((id) => !/^[a-f0-9]{32}$/i.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw failure('Matrices de poules non encore publiées.');
  const fragments = new Array(ids.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        const i = next++;
        fragments[i] = await client.get(`${url}/${ids[i]}?dbut=true`);
      }
    }),
  );
  return load(fragments.map((html, i) => `<div id="pool_${ids[i]}">${html}</div>`).join(''));
}
function podiumFromResults(rows, c, matches) {
  if (!Array.isArray(rows)) throw failure('Classement officiel non reconnu.');
  const final = matches.find((m) => m.round === 'T2' && m.isFinished),
    bronze = matches.find((m) => m.round === 'Bronze' && m.isFinished);
  if (!final || (c.podiumFormat === 'TEAM' && !bronze)) return null;
  const at = (n) => rows.filter((r) => String(r.place).replace(/T$/, '') === String(n));
  if (at(1).length !== 1 || at(2).length !== 1 || at(3).length !== (c.podiumFormat === 'TEAM' ? 1 : 2))
    throw failure('Médailles officielles non définitives ou ambiguës.');
  const entry = (r) => {
    const found = c.podiumRoster.filter((e) => e.id === r.id && norm(e.name) === norm(r.name));
    if (found.length !== 1) throw failure('Identité du médaillé différente de la liste des engagés.');
    return found[0];
  };
  const gold = entry(at(1)[0]),
    silver = entry(at(2)[0]),
    third = at(3).map(entry);
  if (
    norm(gold.name) !== norm(final[`player${final.winner}`]) ||
    norm(silver.name) !== norm(final[`player${3 - final.winner}`])
  )
    throw failure('Le classement final ne correspond pas à la finale.');
  if (bronze && norm(third[0].name) !== norm(bronze[`player${bronze.winner}`]))
    throw failure('La médaille de bronze ne correspond pas à la petite finale.');
  if (c.podiumFormat === 'INDIVIDUAL') {
    const semis = matches.filter((m) => m.round === 'T4' && m.isFinished);
    if (semis.length !== 2 || third.some((e) => !semis.some((m) => norm(m[`player${3 - m.winner}`]) === norm(e.name))))
      throw failure('Les bronzes ne correspondent pas aux demi-finales.');
  }
  return {
    gold: gold.id,
    silver: silver.id,
    bronze1: third[0].id,
    ...(third[1] ? { bronze2: third[1].id } : {}),
    finalConfirmed: true,
    ...(bronze ? { bronzeMatchConfirmed: true } : {}),
  };
}
async function observe(c, existing, client, configured = null, loggedIn = false) {
  const urls = [...new Set([...existing.map((m) => m.sourceUrl), configured?.sourceUrl].filter(Boolean))];
  if (urls.length !== 1 || !sourcePattern.test(urls[0]))
    throw failure('Un tableau FencingTimeLive officiel doit être relié à cette épreuve.', 409);
  const sourceUrl = urls[0],
    eventId = sourcePattern.exec(sourceUrl)[1].toUpperCase(),
    config = configured || events[eventId];
  if (!config)
    throw failure(
      'Cette épreuve doit être configurée pour le contrôle FencingTimeLive (identité et fuseau horaire).',
      409,
    );
  if (
    c.name !== config.name ||
    c.podiumFormat !== config.format ||
    c.rosterSourceUrl !== `${ORIGIN}/events/competitors/${eventId}`
  )
    throw failure('La source ne correspond pas à cette épreuve.', 409);
  podiumRules.roster(c);
  if (!loggedIn) await client.login();
  const $ = verifyPage(await client.get(sourceUrl), config);
  const trees = await client.get(sourceUrl + '/trees');
  if (!Array.isArray(trees)) throw failure('Liste des tableaux officiels indisponible.');
  const main = trees.filter((t) => t.treeNum === 0),
    bronzes = trees.filter((t) => clean(t.name) === 'Bronze Medal');
  if (main.length !== 1 || bronzes.length > 1 || (c.podiumFormat === 'TEAM' && bronzes.length !== 1))
    throw failure('Tableau principal ou petite finale non identifiable.');
  let matches = [],
    rounds = [];
  for (const t of [...main, ...(c.podiumFormat === 'TEAM' ? bronzes : [])]) {
    if (!/^[a-f0-9]{32}$/i.test(t.guid) || !Number.isSafeInteger(t.numTables) || t.numTables < 1 || t.numTables > 10)
      throw failure('Structure officielle inattendue.');
    const html = await client.get(`${sourceUrl}/trees/${t.guid}/tables/0/${t.numTables + 1}`);
    const parsed = parseTable(html, {
      roster: c.podiumRoster,
      ...config,
      maxScore: c.podiumFormat === 'TEAM' ? 45 : 15,
      bronze: t !== main[0],
    });
    matches.push(...parsed.matches);
    rounds.push(...parsed.rounds);
  }
  validateManifest(rounds);
  if (new Set(matches.map((m) => m.sourceKey)).size !== matches.length) throw failure('Clés de rencontres dupliquées.');
  let officialPodium = null,
    resultsSourceUrl = null;
  const warnings = [];
  if (
    matches.some((m) => m.round === 'T2' && m.isFinished) &&
    (c.podiumFormat !== 'TEAM' || matches.some((m) => m.round === 'Bronze' && m.isFinished))
  ) {
    try {
      const path = `/events/results/${eventId}`;
      if (
        !$('a')
          .toArray()
          .some((a) => $(a).attr('href') === path || $(a).attr('href') === ORIGIN + path)
      )
        throw failure('Lien Results absent du tableau officiel.');
      resultsSourceUrl = ORIGIN + path;
      const resultPage = load(await client.get(resultsSourceUrl));
      const dataPath = resultPage('#resultList').attr('data-url');
      if (
        dataPath !== `/events/results/data/${eventId}` ||
        !resultPage('h3')
          .toArray()
          .some((e) => clean(resultPage(e).text()) === 'Final Results')
      )
        throw failure('Classement final non publié.');
      officialPodium = podiumFromResults(await client.get(dataPath), c, matches);
    } catch (e) {
      warnings.push(e.status ? e.message : 'Podium non vérifiable pour le moment.');
    }
  }
  return { sourceUrl, matches, rounds, officialPodium, resultsSourceUrl, warnings, checkedAt: new Date() };
}
function planMatches(existing, observation, { allowPartial = false } = {}) {
  existing = existing.filter((m) => m.resultType !== 'CANCELLED');
  const seen = new Set();
  const conflicts = [];
  const conflict = (current, message, observed = null) => {
    if (!allowPartial) throw failure(message, 409);
    conflicts.push({
      id: current.id,
      message,
      sourceKey: current.sourceKey,
      previous: [current.player1, current.player2],
      official: observed ? [observed.player1, observed.player2] : null,
    });
    return null;
  };
  const plan = observation.matches
    .map((m) => {
      let current = existing.find((e) => e.sourceKey === m.sourceKey);
      if (!current) {
        const pair = existing.filter((e) => !e.sourceUrl && !e.sourceKey && pairKey(e) === pairKey(m));
        if (pair.length > 1) throw failure('Plusieurs rencontres non sourcées correspondent à la même paire.', 409);
        current = pair[0];
      }
      if (current) {
        seen.add(current.id);
        if (
          !samePair(current, m) ||
          (current.round && current.round !== m.round) ||
          (current.sourceUrl && current.sourceUrl !== observation.sourceUrl)
        )
          return conflict(
            current,
            `Match #${current.id} : adversaires ou source du tableau officiel modifiés. Pronostics conservés en attente de vérification.`,
            m,
          );
        if (current.isFinished && !m.isFinished)
          return conflict(
            current,
            `Le résultat du match #${current.id} a été retiré de la source. Vérification requise.`,
            m,
          );
      }
      return { current, observed: m };
    })
    .filter(Boolean);
  for (const m of existing.filter((m) => !seen.has(m.id)))
    conflict(m, `Le match #${m.id} ne figure plus dans le tableau officiel. Vérification requise.`);
  plan.conflicts = conflicts;
  return plan;
}
function cancellable(m, observation) {
  return (
    !m.isFinished &&
    m.sourceUrl === observation.sourceUrl &&
    !observation.matches.some((o) => o.round === m.round && pairKey(o) === pairKey(m))
  );
}
function drawSignature(observation) {
  return JSON.stringify(observation.matches.map((m) => [m.sourceKey, m.round, m.player1, m.player2]));
}
async function applyObservation(tx, c, observation, actorId, leaseToken = null) {
  await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
  if (leaseToken) await require('./ftlScheduler').assertClaim(tx, c.id, leaseToken);
  await tx.$queryRaw`SELECT id FROM "Match" WHERE "competitionId"=${c.id} ORDER BY id FOR UPDATE`;
  const current = await tx.competition.findUnique({ where: { id: c.id } });
  for (const k of ['name', 'podiumFormat', 'podiumRoster', 'rosterSourceUrl'])
    if (JSON.stringify(current?.[k]) !== JSON.stringify(c[k]))
      throw failure('La configuration de l’épreuve a changé pendant le contrôle.', 409);
  let existing = await tx.match.findMany({ where: { competitionId: c.id } }),
    plan = planMatches(existing, observation, { allowPartial: true });
  const cancelled = [];
  if (observation.drawConfirmed) {
    for (const issue of plan.conflicts) {
      const m = existing.find((m) => m.id === issue.id);
      if (!cancellable(m, observation)) continue;
      const reason = 'Rencontre annulée : affiche retirée du tableau officiel. Pronostic conservé, sans points.';
      // Free the official slot without changing any participant, prediction or identifier.
      await tx.match.update({
        where: { id: m.id },
        data: {
          sourceKey: `cancelled:${m.id}:${m.sourceKey}`,
          resultType: 'CANCELLED',
          isFinished: true,
          isLocked: true,
          manualUnlock: false,
          winner: null,
          score1: null,
          score2: null,
          syncIssue: reason,
        },
      });
      await tx.prediction.updateMany({ where: { matchId: m.id }, data: { pointsEarned: 0, bonusPoints: 0 } });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'Affiche annulée après remaniement officiel',
          targetType: 'Match',
          targetId: m.id,
          before: { sourceKey: m.sourceKey, player1: m.player1, player2: m.player2 },
          after: { reason, sourceUrl: observation.sourceUrl, official: issue.official },
        },
      });
      cancelled.push(m.id);
    }
    if (cancelled.length) {
      existing = await tx.match.findMany({ where: { competitionId: c.id } });
      plan = planMatches(existing, observation, { allowPartial: true });
    }
  }
  const oldRounds = await tx.matchRound.findMany({ where: { competitionId: c.id } });
  if (oldRounds.some((r) => !observation.rounds.some((n) => n.round === r.round)))
    throw failure('Un tour enregistré a disparu du tableau.', 409);
  const summary = {
    cancelledIds: cancelled,
    cancelled: cancelled.length,
    createdIds: [],
    created: 0,
    results: 0,
    corrections: 0,
    pointsUpdated: 0,
    podium: false,
    checked: plan.length,
    checkedAt: observation.checkedAt.toISOString(),
    warnings: [...observation.warnings],
    conflicts: plan.conflicts,
  };
  for (const issue of plan.conflicts) {
    // No score, opponent, prediction, key or freshness changes on an ambiguous match.
    await tx.match.update({ where: { id: issue.id }, data: { syncIssue: issue.message } });
    summary.warnings.push(issue.message);
  }
  for (const r of observation.rounds)
    await tx.matchRound.upsert({
      where: { competitionId_round: { competitionId: c.id, round: r.round } },
      create: { competitionId: c.id, ...r, sourceUrl: observation.sourceUrl, verifiedAt: observation.checkedAt },
      update: { ...r, sourceUrl: observation.sourceUrl, verifiedAt: observation.checkedAt },
    });
  for (const { current: m, observed: o } of plan) {
    const wasFinished = m?.isFinished;
    // Legacy scored finals may lack an explicit winner/type; filling those is not a score correction.
    const previousWinner =
      m?.winner ??
      (Number.isInteger(m?.score1) && Number.isInteger(m?.score2) && m.score1 !== m.score2
        ? m.score1 > m.score2
          ? 1
          : 2
        : null);
    const corrected =
      wasFinished &&
      (m.score1 !== o.score1 ||
        m.score2 !== o.score2 ||
        previousWinner !== o.winner ||
        (m.resultType === 'MEDICAL_WITHDRAWAL') !== (o.resultType === 'MEDICAL_WITHDRAWAL'));
    const data = {
      sourceUrl: observation.sourceUrl,
      sourceKey: o.sourceKey,
      round: o.round,
      syncIssue: null,
      sourceCheckedAt: observation.checkedAt,
      ...(o.startsAt ? { startsAt: o.startsAt } : {}),
    };
    if (o.isFinished)
      Object.assign(data, {
        score1: o.score1,
        score2: o.score2,
        winner: o.winner,
        resultType: o.resultType,
        isFinished: true,
        isLocked: true,
        manualUnlock: false,
      });
    const saved = m
      ? await tx.match.update({ where: { id: m.id }, data })
      : await tx.match.create({ data: { competitionId: c.id, player1: o.player1, player2: o.player2, ...data } });
    if (!m) {
      summary.created++;
      summary.createdIds.push(saved.id);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184725)`;
      await tx.pushEvent.create({ data: { matchId: saved.id, competitionId: c.id } });
    }
    if (o.isFinished) {
      if (!wasFinished) summary.results++;
      else if (corrected) summary.corrections++;
      const predictions = await tx.prediction.findMany({ where: { matchId: saved.id } });
      summary.pointsUpdated += await rescore(
        tx.prediction,
        { matchId: saved.id },
        predictions,
        ['predictedScore1', 'predictedScore2'],
        (p) => calculateMatchPoints(p.predictedScore1, p.predictedScore2, o.score1, o.score2, o.winner, o.resultType),
      );
      // Bonus outsider, calculé à la publication du résultat.
      summary.pointsUpdated += await applyOutsiderBonus(tx.prediction, saved.id, predictions, o.winner, o.resultType);
    }
  }
  if (observation.officialPodium) {
    // Validate every legacy selection before writing anything to the podium.
    const predictions = await tx.podiumPrediction.findMany({ where: { competitionId: c.id } });
    let valid = true;
    try {
      predictions.forEach((p) => podiumRules.predictionIds(current, p));
    } catch (e) {
      summary.warnings.push(e.message);
      valid = false;
    }
    if (valid) {
      await tx.competition.update({
        where: { id: c.id },
        data: {
          officialPodium: observation.officialPodium,
          resultsSourceUrl: observation.resultsSourceUrl,
          resultsVerifiedAt: observation.checkedAt,
        },
      });
      await podiumRules.resolvePodium(tx, c.id);
      summary.podium = true;
    }
  }

  return summary;
}
async function syncPools(db, c, config, actorId, client, leaseToken = null) {
  const pools = await db.pool.findMany({
    where: { competitionId: c.id },
    include: { fencers: { orderBy: { position: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  const urls = [...new Set([...pools.map((p) => p.sourceUrl), ...(config.poolSources || [])].filter(Boolean))];
  const summary = { checked: 0, locks: 0, finalized: 0, changed: 0, pointsUpdated: 0, warnings: [] };
  for (const url of urls) {
    try {
      const match = poolPattern.exec(url);
      if (
        !match ||
        c.rosterSourceUrl?.toUpperCase() !==
          `https://www.fencingtimelive.com/events/competitors/${match[1]}`.toUpperCase()
      )
        throw failure('Source de poules différente de la liste des engagés.');
      const $ = await poolMatrices(verifyPage(await client.get(url), config), url, client),
        tables = $('table.poolTable').toArray();
      if (!tables.length) throw failure('Matrices de poules non encore publiées.');
      const poolNumbers = tables.map((t) => clean($(t).parent().find('.poolNum').text()));
      if (new Set(poolNumbers).size !== poolNumbers.length) throw failure('Numéros de poules ambigus.');
      for (const table of tables) {
        try {
          const observed = parsePools($.html($(table).parent()))[0];
          for (const row of observed.rows)
            if ((c.podiumRoster || []).filter((e) => norm(e.name) === norm(row.name)).length !== 1)
              throw failure('Composition de poule absente ou ambiguë dans les engagés.');
          let snapshot = pools.find((p) => p.sourceUrl === url && p.sourcePoolNumber === observed.number);
          if (!snapshot) {
            const candidates = pools.filter(
              (p) =>
                !p.sourceUrl &&
                !p.sourcePoolNumber &&
                p.name === `Poule ${observed.number}` &&
                p.fencers.length === observed.rows.length &&
                p.fencers.every(
                  (f, i) => f.position === observed.rows[i].position && norm(f.name) === norm(observed.rows[i].name),
                ),
            );
            if (candidates.length === 1) {
              const original = candidates[0];
              snapshot = await db.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM "Pool" WHERE id=${original.id} FOR UPDATE`;
                const current = await tx.pool.findUnique({
                  where: { id: original.id },
                  include: { fencers: { orderBy: { position: 'asc' } } },
                });
                if (
                  current.sourceUrl ||
                  current.sourcePoolNumber ||
                  JSON.stringify(current.fencers.map((f) => [f.id, f.name, f.position])) !==
                    JSON.stringify(original.fencers.map((f) => [f.id, f.name, f.position]))
                )
                  throw failure('Composition de poule modifiée.', 409);
                return tx.pool.update({
                  where: { id: original.id },
                  data: { sourceUrl: url, sourcePoolNumber: observed.number },
                  include: { fencers: { orderBy: { position: 'asc' } } },
                });
              });
              Object.assign(original, snapshot);
            }
          }
          if (!snapshot) {
            // Do not duplicate an existing pool whose source has not been reconciled yet.
            if (pools.some((p) => p.fencers.some((f) => observed.rows.some((r) => norm(r.name) === norm(f.name)))))
              throw failure(`Poule ${observed.number} déjà présente sans correspondance de source certaine.`);
            snapshot = await db.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
              const current = await tx.competition.findUnique({ where: { id: c.id } });
              if (
                JSON.stringify(current.podiumRoster) !== JSON.stringify(c.podiumRoster) ||
                current.rosterSourceUrl !== c.rosterSourceUrl
              )
                throw failure('Liste des engagés modifiée.', 409);
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
    } catch (e) {
      summary.warnings.push(e.status ? e.message : 'Source de poules temporairement indisponible.');
    }
  }
  return summary;
}
async function syncCompetition(db, competitionId, actorId, client = createClient(), { automatic = false } = {}) {
  const scheduler = require('./ftlScheduler');
  const claim = await scheduler.claim(db, competitionId, { automatic });
  if (!claim) return null;
  let c = claim.competition;
  try {
    await db.auditLog.create({
      data: { actorId, action: START, targetType: 'Competition', targetId: competitionId, after: { automatic } },
    });
    const existing = await db.match.findMany({ where: { competitionId } }),
      configured = await configuration(db, competitionId);
    const source = [
      ...existing.map((m) => m.sourceUrl),
      configured?.sourceUrl,
      configured?.poolSources?.[0],
      c.rosterSourceUrl,
    ].find(Boolean);
    const eventId = source?.match(/([a-f0-9]{32})/i)?.[1]?.toUpperCase();
    let config = configured || events[eventId];
    if (!config || c.name !== config.name || c.podiumFormat !== config.format)
      throw failure('Configurez la source et l’identité de cette épreuve dans Administration.', 409);
    await client.login();
    ({ c, config } = await require('./ftlTournament').refreshPending(db, c, config, actorId, client));
    const poolSummary = await syncPools(db, c, config, actorId, client, claim.token);
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
    if (existing.some((m) => m.sourceUrl) || config.sourceUrl) {
      try {
        let observation = await observe(
          c,
          existing.filter((m) => m.resultType !== 'CANCELLED'),
          client,
          config,
          true,
        );
        const conflicts = planMatches(existing, observation, { allowPartial: true }).conflicts;
        if (
          conflicts.some((i) =>
            cancellable(
              existing.find((m) => m.id === i.id),
              observation,
            ),
          )
        ) {
          const confirmation = await observe(
            c,
            existing.filter((m) => m.resultType !== 'CANCELLED'),
            client,
            config,
            true,
          );
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
    }
    // Simple information, pas une anomalie : le suivi reste « à jour » et garde son rythme normal.
    else summary.notes = ['Tableau pas encore publié. Il sera recherché au prochain contrôle.'];
    summary.automatic = automatic;
    summary.eventDate = config.date;
    const start = require('./eventStart').eventStart(config);
    if (start !== null) summary.eventStart = new Date(start).toISOString();
    // Poules encore ouvertes au « premier résultat » : le suivi doit rester frais (2 min) pendant l'épreuve.
    try {
      summary.openFirstResultPools = await db.pool.count({
        where: { competitionId: c.id, lockMode: 'FIRST_RESULT', isLocked: false, isFinal: false },
      });
    } catch {
      summary.openFirstResultPools = 0;
    }
    summary.pools = poolSummary;
    summary.pointsUpdated += poolSummary.pointsUpdated;
    summary.warnings.push(...poolSummary.warnings);
    // Ranking history must never roll back a certain score or first-result lock.
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184723)`;
          await captureRankings(tx, c, actorId);
        },
        { timeout: 30000 },
      );
    } catch {
      summary.warnings.push('Résultats enregistrés, historique du classement à réessayer au prochain contrôle.');
    }
    await db.auditLog.create({
      data: { actorId, action: DONE, targetType: 'Competition', targetId: c.id, after: summary },
    });
    await scheduler.finish(db, competitionId, claim.token, summary);
    return summary;
  } catch (e) {
    const safe = e.status
      ? e
      : failure('Le contrôle n’a pas pu être terminé. Réessayez pour vérifier les résultats déjà enregistrés.', 500);
    await db.auditLog
      .create({
        data: {
          actorId,
          action: FAILED,
          targetType: 'Competition',
          targetId: competitionId,
          after: { error: safe.message, automatic },
        },
      })
      .catch(() => {});
    await scheduler.finish(db, competitionId, claim.token, null, safe.message).catch(() => {});
    throw safe;
  }
}
async function syncStatus(db, competitionId) {
  const [last, state] = await Promise.all([
    db.auditLog.findFirst({
      where: { targetType: 'Competition', targetId: competitionId, action: { in: [DONE, FAILED] } },
      orderBy: { createdAt: 'desc' },
    }),
    db.ftlSyncState.findUnique({ where: { competitionId } }),
  ]);
  return {
    last: last ? { at: last.createdAt, success: last.action === DONE, summary: last.after } : null,
    nextAllowedAt: state?.lastStartedAt ? new Date(state.lastStartedAt.getTime() + COOLDOWN) : null,
    automatic: {
      enabled: require('./ftlScheduler').enabled(),
      status: state?.status || 'PENDING',
      nextAt: state?.nextAutomaticAt || null,
      lastError: state?.lastError || null,
    },
  };
}
// Un contrôle (manuel ou automatique) peut changer les points : on vide le cache du classement.
async function syncAndRefresh(...args) {
  try {
    return await syncCompetition(...args);
  } finally {
    require('./standings').invalidateStandings();
  }
}
module.exports = {
  syncCompetition: syncAndRefresh,
  syncStatus,
  observe,
  planMatches,
  applyObservation,
  podiumFromResults,
  verifyPage,
  poolMatrices,
  cancellable,
  drawSignature,
};
