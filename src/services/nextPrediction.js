const { eventStart } = require('./eventStart');
const { fencerClosed } = require('./poolRules');
const { roundContext, matchClosed } = require('../lib/matchLock');
const { liveDetectedAt } = require('../lib/liveDetection');
const { CORRECTION } = require('./schedule');

// Choix d’une étape réellement disponible : règles de fermeture partagées avec la saisie.
function chooseNextPrediction(competitions, configs, rounds, now = Date.now()) {
  const candidates = [];
  for (const c of competitions) {
    const config = configs.get(c.id);
    const start = config?.timezone && (config.time || config.eventTime) ? eventStart(config) : null;
    const base = {
      id: c.id,
      name: c.name,
      tournament: { id: c.tournament.id, name: c.tournament.name, city: config?.city || null },
    };
    const pools = c.pools.filter((p) => p.fencers.some((f) => !fencerClosed(p, f, new Date(now), start)));
    if (pools.length) {
      const times = pools.map((p) => (p.startsAt ? +new Date(p.startsAt) : start)).filter(Number.isFinite);
      if (times.length)
        candidates.push({
          ...base,
          startsAt: new Date(Math.min(...times)).toISOString(),
          view: 'poules',
          phase: null,
          stage: 'Poules',
        });
    }
    const matches = roundContext(c.matches, rounds).map((m) => ({ ...m, liveDetectedAt: liveDetectedAt(m) }));
    const open = matches.filter((m) => !matchClosed(m, now));
    for (const phase of ['preliminary', 'main']) {
      const mine = open.filter((m) => (m.round.startsWith('J1:') ? 'preliminary' : 'main') === phase);
      if (!mine.length) continue;
      const times = mine.map((m) => m.startsAt && +new Date(m.startsAt)).filter((t) => Number.isFinite(t) && t > 0);
      if (!times.length) continue; // pas de faux horaire ni de J2 déduit de la date J1
      const multiphase = c.matches.some((m) => m.round.startsWith('J1:')) || config?.scheduleSessions?.length > 1;
      candidates.push({
        ...base,
        startsAt: new Date(Math.min(...times)).toISOString(),
        view: 'tableau',
        phase: multiphase ? phase : null,
        stage: multiphase
          ? phase === 'preliminary'
            ? 'J1 · Tableau préliminaire'
            : 'J2 · Tableau principal'
          : 'Tableau',
      });
    }
  }
  return candidates.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id - b.id)[0] || null;
}
async function nextPrediction(db, now = Date.now()) {
  const competitions = await db.competition.findMany({
    where: { tournament: { archivedAt: null } },
    select: {
      id: true,
      name: true,
      tournament: { select: { id: true, name: true } },
      pools: {
        select: {
          isLocked: true,
          isFinal: true,
          closesAt: true,
          lockMode: true,
          sourceCheckedAt: true,
          startsAt: true,
          fencers: { select: { status: true, firstResultAt: true } },
        },
      },
      matches: {
        select: {
          id: true,
          competitionId: true,
          player1: true,
          player2: true,
          round: true,
          startsAt: true,
          isFinished: true,
          isLocked: true,
          liveDetectedAt: true,
          syncIssue: true,
          progressionConfirmedAt: true,
          resultRegisteredAt: true,
          resultType: true,
        },
      },
    },
  });
  const ids = competitions.map((c) => c.id);
  if (!ids.length) return null;
  const [audits, rounds] = await Promise.all([
    db.auditLog.findMany({
      where: {
        action: { in: ['Configuration FTL validée', CORRECTION] },
        targetType: 'Competition',
        targetId: { in: ids },
      },
      orderBy: { id: 'asc' },
      select: { targetId: true, after: true, action: true },
    }),
    db.matchRound.findMany({ where: { competitionId: { in: ids } } }),
  ]);
  const configs = new Map();
  for (const a of audits)
    configs.set(a.targetId, a.action === CORRECTION ? { ...(configs.get(a.targetId) || {}), ...a.after } : a.after);
  return chooseNextPrediction(competitions, configs, rounds, now);
}
module.exports = { nextPrediction, chooseNextPrediction };
