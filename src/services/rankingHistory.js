const { computeStandings: standings } = require('./standings');
const ACTION = 'Classement après import';
// Snapshots live in Neon’s append-only audit journal, with no client-specific state.
async function captureRankings(db, c, actorId) {
  for (const [targetType, targetId, filter] of [
    ['RankingGlobal', 0, {}],
    ['RankingTournament', c.tournamentId, { tournamentId: c.tournamentId }],
    ['RankingCompetition', c.id, { competitionId: c.id }],
  ]) {
    const rows = (await standings(db, filter)).map(({ id, rank, totalPoints }) => ({ id, rank, totalPoints }));
    const last = await db.auditLog.findFirst({
      where: { action: ACTION, targetType, targetId },
      orderBy: { id: 'desc' },
    });
    if (JSON.stringify(last?.after?.rows) !== JSON.stringify(rows))
      await db.auditLog.create({ data: { actorId, action: ACTION, targetType, targetId, after: { rows } } });
  }
}
async function rankProgress(db, tournamentId, userId) {
  const snapshots = await db.auditLog.findMany({
    where: { action: ACTION, targetType: 'RankingTournament', targetId: tournamentId },
    orderBy: { id: 'desc' },
    take: 2,
  });
  if (snapshots.length < 2) return null;
  const current = snapshots[0].after?.rows?.find((r) => r.id === userId),
    previous = snapshots[1].after?.rows?.find((r) => r.id === userId);
  return current && previous
    ? { change: previous.rank - current.rank, date: snapshots[1].createdAt, checkedAt: snapshots[0].createdAt }
    : null;
}
module.exports = { captureRankings, rankProgress };
