const { rankRows } = require('./ranking');
const { challengePoints } = require('./communityRules');
async function computeStandings(db, { competitionId, tournamentId } = {}) {
  const comp = competitionId ? { id: competitionId } : tournamentId ? { tournamentId } : {};
  const comps = await db.competition.findMany({ where: comp, select: { id: true } }),
    ids = comps.map((c) => c.id);
  const [users, podiums, matches, pools, adjustments, challenges] = await Promise.all([
    db.user.findMany({ select: { id: true, name: true } }),
    db.podiumPrediction.findMany({ where: { competitionId: { in: ids } } }),
    db.prediction.findMany({ where: { match: { competitionId: { in: ids } } } }),
    db.poolPrediction.findMany({ where: { fencer: { pool: { competitionId: { in: ids } } } } }),
    db.pointAdjustment.findMany({
      where: competitionId
        ? { competitionId }
        : tournamentId
          ? { OR: [{ tournamentId }, { competitionId: { in: ids } }] }
          : {},
    }),
    db.challenge.findMany({ include: { picks: true } }),
  ]);
  const challengeMatches = await db.match.findMany({
    where: { id: { in: challenges.map((c) => c.matchId) }, competitionId: { in: ids } },
  });
  const rows = new Map(
    users.map((u) => [
      u.id,
      { ...u, podiumPoints: 0, matchPoints: 0, poolPoints: 0, adjustmentPoints: 0, challengePoints: 0 },
    ]),
  );
  for (const [data, key] of [
    [podiums, 'podiumPoints'],
    [matches, 'matchPoints'],
    [pools, 'poolPoints'],
    [adjustments, 'adjustmentPoints'],
  ])
    for (const p of data) {
      const row = rows.get(p.userId);
      if (row) row[key] += p.pointsEarned ?? p.points ?? 0;
    }
  for (const c of challenges) {
    const m = challengeMatches.find((m) => m.id === c.matchId);
    for (const p of c.picks) {
      const row = rows.get(p.userId);
      if (row) row.challengePoints += challengePoints(p, m, c.bonus);
    }
  }
  return rankRows(
    [...rows.values()].map((r) => ({
      ...r,
      totalPoints: r.podiumPoints + r.matchPoints + r.poolPoints + r.adjustmentPoints + r.challengePoints,
    })),
  );
}
// Cache court : le classement est relu à chaque affichage, mais les points ne
// changent qu'après un import, une correction ou un ajustement. Toute écriture
// réussie (voir server.js) et chaque contrôle FencingTimeLive vident le cache.
const TTL = 30000;
const caches = new WeakMap();
let generation = 0;
function invalidateStandings() {
  generation++;
}
function standings(db, filter = {}) {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  const key = JSON.stringify([filter.competitionId || null, filter.tournamentId || null]);
  const hit = cache.get(key);
  if (hit && hit.generation === generation && Date.now() - hit.at < TTL) return hit.promise;
  const promise = computeStandings(db, filter);
  cache.set(key, { at: Date.now(), generation, promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

module.exports = { standings, computeStandings, invalidateStandings };
