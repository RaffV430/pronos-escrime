const { normalize, resolve } = require('./fencerFollows');
const { failure } = require('./ftlClient');
const RECENT_EVENTS = 40;
async function history(db, userId, favoriteId) {
  const favorite = await db.followedFencer.findFirst({ where: { id: favoriteId, userId } });
  if (!favorite) throw failure('Favori introuvable.', 404);
  const competitions = await db.competition.findMany({
    where: { podiumFormat: 'INDIVIDUAL' },
    select: {
      id: true,
      name: true,
      tournamentId: true,
      createdAt: true,
      podiumFormat: true,
      podiumRoster: true,
      officialPodium: true,
      resultsSourceUrl: true,
      resultsVerifiedAt: true,
      tournament: { select: { id: true, name: true, archivedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    // Dernière épreuve disputée : les épreuves les plus récentes suffisent (requête bornée).
    take: RECENT_EVENTS,
  });
  const decorated = await require('./fencerAffiliations').decorate(db, competitions, [favorite]);
  const candidates = [];
  for (const competition of decorated.competitions) {
    // Épreuves parcourues de la plus récente à la plus ancienne : trois épreuves disputées suffisent
    // pour retrouver la dernière (l'ordre de création suit de près l'ordre des dates).
    if (candidates.length >= 3) break;
    const linked = resolve(decorated.favorites, competition);
    const link = linked.links.find((l) => l.favoriteId === favoriteId);
    if (!link) continue;
    const entry = competition.podiumRoster.find((e) => String(e.id) === link.entryId);
    if (!linked.matchNames.includes(entry.name)) continue; // Homonyms have no name-only history.
    const [allMatches, allPools] = await Promise.all([
      // Seulement les rencontres et les poules de ce tireur (filtrées par la base, plus tout le tableau).
      db.match.findMany({
        where: {
          competitionId: competition.id,
          OR: [
            { player1: { equals: entry.name, mode: 'insensitive' } },
            { player2: { equals: entry.name, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          player1: true,
          player2: true,
          score1: true,
          score2: true,
          winner: true,
          isFinished: true,
          resultType: true,
          round: true,
          startsAt: true,
          strip: true,
          sourceCheckedAt: true,
        },
        orderBy: { id: 'asc' },
      }),
      db.pool.findMany({
        where: {
          competitionId: competition.id,
          fencers: { some: { name: { equals: entry.name, mode: 'insensitive' } } },
        },
        include: { fencers: { orderBy: { position: 'asc' } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const matches = allMatches.filter((m) =>
      [m.player1, m.player2].some((name) => normalize(name) === normalize(entry.name)),
    );
    const pools = allPools.filter(
      (p) => p.fencers.filter((f) => normalize(f.name) === normalize(entry.name)).length === 1,
    );
    if (!matches.some((m) => m.isFinished) && !pools.some((p) => p.fencers.some((f) => f.wins != null))) continue; // Future entries are not the last competed event.
    const rank =
      competition.officialPodium?.finalConfirmed && competition.resultsVerifiedAt
        ? competition.officialPodium.classification?.find((r) => r.entryId === link.entryId) || null
        : null;
    const { podiumRoster, officialPodium, ...event } = competition;
    const dates = [
      ...matches.filter((m) => m.isFinished).map((m) => Date.parse(m.startsAt)),
      ...pools.map((p) => Date.parse(p.startsAt)),
    ].filter((d) => Number.isFinite(d) && d <= Date.now());
    candidates.push({
      at: dates.length ? Math.max(...dates) : Date.parse(competition.createdAt) || 0,
      data: { favorite: { id: favorite.id, name: favorite.name }, entryName: entry.name, event, rank, matches, pools },
    });
  }
  if (candidates.length) return candidates.sort((a, b) => b.at - a.at)[0].data;
  return { favorite: { id: favorite.id, name: favorite.name }, event: null, rank: null, matches: [], pools: [] };
}
module.exports = { history };
