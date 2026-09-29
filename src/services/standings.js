const { rankRows } = require('./ranking');
const { challengePoints } = require('./communityRules');
// Somme des points par joueur, calculée par la base (GROUP BY) au lieu de charger chaque pronostic
// en mémoire. Les doubles de test sans groupBy passent par une somme en JavaScript équivalente.
async function sumByUser(model, where, fields) {
  if (typeof model.groupBy === 'function') {
    const rows = await model.groupBy({ by: ['userId'], where, _sum: Object.fromEntries(fields.map((f) => [f, true])) });
    return new Map(rows.map((r) => [r.userId, Object.fromEntries(fields.map((f) => [f, r._sum[f] || 0]))]));
  }
  const totals = new Map();
  for (const row of await model.findMany({ where })) {
    const t = totals.get(row.userId) || Object.fromEntries(fields.map((f) => [f, 0]));
    for (const f of fields) t[f] += row[f] || 0;
    totals.set(row.userId, t);
  }
  return totals;
}
async function computeStandings(db, { competitionId, tournamentId } = {}) {
  const general = !competitionId && !tournamentId;
  const comp = competitionId ? { id: competitionId } : tournamentId ? { tournamentId } : {};
  const ids = general ? null : (await db.competition.findMany({ where: comp, select: { id: true } })).map((c) => c.id);
  const inScope = (where) => (general ? {} : where);
  const [users, podiums, matches, pools, adjustments, challenges] = await Promise.all([
    db.user.findMany({ select: { id: true, name: true } }),
    sumByUser(db.podiumPrediction, inScope({ competitionId: { in: ids } }), ['pointsEarned']),
    sumByUser(db.prediction, inScope({ match: { competitionId: { in: ids } } }), ['pointsEarned', 'bonusPoints']),
    sumByUser(db.poolPrediction, inScope({ fencer: { pool: { competitionId: { in: ids } } } }), ['pointsEarned']),
    sumByUser(
      db.pointAdjustment,
      competitionId
        ? { competitionId }
        : tournamentId
          ? { OR: [{ tournamentId }, { competitionId: { in: ids } }] }
          : {},
      ['points'],
    ),
    db.challenge.findMany({ include: { picks: true } }),
  ]);
  const challengeMatches = await db.match.findMany({
    where: { id: { in: challenges.map((c) => c.matchId) }, ...(general ? {} : { competitionId: { in: ids } }) },
  });
  const rows = new Map(
    users.map((u) => [
      u.id,
      {
        ...u,
        podiumPoints: 0,
        matchPoints: 0,
        outsiderPoints: 0,
        poolPoints: 0,
        adjustmentPoints: 0,
        challengePoints: 0,
      },
    ]),
  );
  for (const [totals, field, key] of [
    [podiums, 'pointsEarned', 'podiumPoints'],
    [matches, 'pointsEarned', 'matchPoints'],
    [matches, 'bonusPoints', 'outsiderPoints'],
    [pools, 'pointsEarned', 'poolPoints'],
    [adjustments, 'points', 'adjustmentPoints'],
  ])
    for (const [userId, sums] of totals) {
      const row = rows.get(userId);
      if (row) row[key] += sums[field] || 0;
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
      totalPoints:
        r.podiumPoints + r.matchPoints + r.outsiderPoints + r.poolPoints + r.adjustmentPoints + r.challengePoints,
    })),
  );
}
// Cache : le classement est relu à chaque affichage, mais les points ne changent qu'après un
// import, une correction, un ajustement ou la résolution d'un défi. Ces écritures (voir server.js
// et les contrôles FencingTimeLive) vident le cache ; les pronostics des joueurs, non.
const TTL = 60000;
const MAX_KEYS = 50;
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
  cache.delete(key);
  cache.set(key, { at: Date.now(), generation, promise });
  // Taille bornée : on retire les plus anciennes entrées (ordre d'insertion de la Map).
  while (cache.size > MAX_KEYS) cache.delete(cache.keys().next().value);
  promise.catch(() => cache.delete(key));
  return promise;
}

// Écritures fréquentes des joueurs (pronostics, notifications, session…) : aucun point ne change,
// le cache est gardé. Toute autre écriture (administration, résultats, ajustements…) le vide.
const PLAYER_WRITES = [
  /^\/api\/matches\/\d+\/predict$/,
  /^\/api\/pools\/\d+\/fencers\/\d+\/prediction$/,
  /^\/api\/podium\/?$/,
  /^\/api\/notifications\//,
  /^\/api\/auth\/(login|register|refresh|change-password|logout-others|forgot-password|reset-password|2fa\/)/,
  /^\/api\/community\/(join|leagues|leagues\/\d+\/leave|challenges\/\d+\/pick)$/,
];
const changesPoints = (method, path) => method !== 'GET' && !PLAYER_WRITES.some((r) => r.test(path));

module.exports = { standings, computeStandings, invalidateStandings, changesPoints };
