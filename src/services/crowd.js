// Tendances des pronostics d'un match, dévoilées seulement après la clôture.
// rows : résultat de prediction.groupBy par (matchId, score1, score2).
function summarizeCrowd(rows) {
  const byMatch = new Map();
  for (const r of rows) {
    const count = r._count?._all ?? r._count ?? 0;
    if (!count || r.predictedScore1 === r.predictedScore2) continue;
    const s = byMatch.get(r.matchId) || { total: 0, winner1: 0, top: null };
    s.total += count;
    if (r.predictedScore1 > r.predictedScore2) s.winner1 += count;
    if (
      !s.top ||
      count > s.top.count ||
      (count === s.top.count && `${r.predictedScore1}-${r.predictedScore2}` < `${s.top.score1}-${s.top.score2}`)
    )
      s.top = { score1: r.predictedScore1, score2: r.predictedScore2, count };
    byMatch.set(r.matchId, s);
  }
  const out = {};
  for (const [matchId, s] of byMatch) {
    const player1Pct = Math.round((s.winner1 * 100) / s.total);
    out[matchId] = { total: s.total, player1Pct, player2Pct: 100 - player1Pct, topScore: s.top };
  }
  return out;
}

async function crowdFor(db, matchIds) {
  if (!matchIds.length) return {};
  const rows = await db.prediction.groupBy({
    by: ['matchId', 'predictedScore1', 'predictedScore2'],
    where: { matchId: { in: matchIds } },
    _count: { _all: true },
  });
  return summarizeCrowd(rows);
}

module.exports = { summarizeCrowd, crowdFor };
