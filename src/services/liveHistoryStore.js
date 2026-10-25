// Durable observations, separate from official scores and predictions.
const identity = (a, b) => a.sourceUrl === b.sourceUrl && a.sourceKey === b.sourceKey;
function orient(saved, match) {
  if (!saved || !identity(saved, match)) return [];
  if (saved.player1 === match.player1 && saved.player2 === match.player2) return saved.history;
  if (saved.player1 !== match.player2 || saved.player2 !== match.player1) return [];
  return saved.history.map((e) => ({
    ...e,
    score1: e.score2,
    score2: e.score1,
    fencer1Name: e.fencer2Name,
    fencer2Name: e.fencer1Name,
    by: e.by === 1 ? 2 : e.by === 2 ? 1 : e.by,
  }));
}
function combine(previous, incoming) {
  const events = new Map();
  for (const e of [...previous, ...incoming]) events.set(`${e.at}:${e.by}:${e.score1}:${e.score2}`, e);
  return [...events.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
async function read(db, match) {
  return orient(await db.matchLiveHistory.findUnique({ where: { matchId: match.id } }), match);
}
async function persist(db, match, history) {
  if (!history.length) return;
  return db.$transaction(async (tx) => {
    // Serialize competing worker instances during rolling deployments.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(73149, ${match.id}::integer)`;
    const current = await tx.match.findUnique({
      where: { id: match.id },
      select: { player1: true, player2: true, sourceUrl: true, sourceKey: true },
    });
    if (!current || !identity(current, match) || current.player1 !== match.player1 || current.player2 !== match.player2)
      return;
    const previous = await read(tx, match);
    const merged = combine(previous, history);
    if (JSON.stringify(previous) === JSON.stringify(merged)) return;
    const data = {
      player1: match.player1,
      player2: match.player2,
      sourceUrl: match.sourceUrl,
      sourceKey: match.sourceKey,
      history: merged,
    };
    await tx.matchLiveHistory.upsert({
      where: { matchId: match.id },
      create: { matchId: match.id, ...data },
      update: data,
    });
  });
}
async function result(db, matchId) {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      player1: true,
      player2: true,
      sourceUrl: true,
      sourceKey: true,
      score1: true,
      score2: true,
      isFinished: true,
      resultType: true,
    },
  });
  if (!match || match.resultType === 'CANCELLED') return null;
  const history = await read(db, match);
  const last = history.at(-1);
  const conflict =
    match.isFinished &&
    last &&
    Number.isInteger(match.score1) &&
    Number.isInteger(match.score2) &&
    (last.score1 > match.score1 || last.score2 > match.score2);
  return {
    history: conflict ? [] : history,
    historyIssue: conflict ? 'Le déroulé live diffère du résultat officiel ; il est masqué.' : null,
  };
}
module.exports = { orient, combine, read, persist, result };
