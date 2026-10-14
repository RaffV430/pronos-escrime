const fold = (v) =>
  String(v || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
function availability(competition, config, matches) {
  const session = config?.scheduleSessions?.[1];
  if (!session) return { notYetOpen: false };
  const waiting = (reason) => ({ notYetOpen: true, reason });
  const main = matches.filter((m) => /^T\d+$/.test(m.round || '') && m.resultType !== 'CANCELLED');
  const byes = (Array.isArray(competition.tableauByes) ? competition.tableauByes : []).filter((b) =>
    /^T\d+$/.test(b.round || ''),
  );
  const size = Math.max(0, ...[...main, ...byes].map((m) => Number(m.round.slice(1))));
  const first = main.filter((m) => m.round === `T${size}`);
  const firstByes = byes.filter((b) => b.round === `T${size}`);
  const names = new Set(
    [...first.flatMap((m) => [fold(m.player1), fold(m.player2)]), ...firstByes.map((b) => fold(b.name))].filter(
      Boolean,
    ),
  );
  const roster = new Set(
    (Array.isArray(competition.podiumRoster) ? competition.podiumRoster : []).map((e) => fold(e.name)),
  );
  if (
    !size ||
    first.length + firstByes.length !== size / 2 ||
    names.size !== size - firstByes.length ||
    [...names].some((n) => !roster.has(n))
  )
    return waiting('Le podium attend la liste complète du tableau principal, y compris les tireurs exempts.');
  return { notYetOpen: false };
}
async function forCompetition(db, competition) {
  const config = await require('./ftlConfiguration').configuration(db, competition.id);
  if (!config?.scheduleSessions?.[1]) return { notYetOpen: false };
  const matches = await db.match.findMany({
    where: { competitionId: competition.id },
    select: { round: true, player1: true, player2: true, resultType: true },
  });
  return availability(competition, config, matches);
}
module.exports = { availability, forCompetition };
