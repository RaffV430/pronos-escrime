// Toutes les épreuves d'un tireur suivi, saison par saison (septembre → août), pour le tireur ou son
// entraîneur. Le tireur est reconnu par son identité (nom, nation, club, affiliation fédérale), comme
// pour « Mes tireurs » : deux homonymes de clubs ou de nations différents ne sont jamais mélangés.
const { failure } = require('./ftlClient');
const { normalize, resolve } = require('./fencerFollows');
const { competitionEntry } = require('./fencerProfile');
const aliases = require('./fencerAliases');

// Le tireur suivi et ses autres orthographes (mêmes nation, club et affiliation).
async function withAliases(db, favorites) {
  const list = await aliases.groups(db);
  return favorites.flatMap((f) =>
    aliases.expandWith(list, f.name).map((name) => (aliases.norm(name) === aliases.norm(f.name) ? f : { ...f, name })),
  );
}

// Saison sportive : du 1er septembre au 31 août (« 2026-2027 »).
function seasonOf(date) {
  const d = new Date(date);
  const start = d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${start + 1}`;
}
const SEASON = /^(\d{4})-(\d{4})$/;

function summarize(entries) {
  const bouts = entries.flatMap((e) => e.pools.flatMap((p) => p.bouts));
  const tableau = entries.flatMap((e) => e.tableau);
  const places = entries.map((e) => e.result?.place).filter(Number.isInteger);
  // Meilleur résultat : podium, sinon le tour le plus avancé atteint.
  const size = (round) => (/^T\d+$/.test(round || '') ? Number(round.slice(1)) : Infinity);
  const furthest = entries
    .filter((e) => e.result?.round)
    .sort((a, b) => size(a.result.round) - size(b.result.round))[0];
  return {
    competitions: entries.length,
    poolWins: bouts.filter((b) => b.won).length,
    poolLosses: bouts.filter((b) => !b.won).length,
    tableauWins: tableau.filter((m) => m.won).length,
    tableauLosses: tableau.filter((m) => !m.won).length,
    podiums: places.filter((p) => p <= 3).length,
    best: places.length
      ? { place: Math.min(...places), label: Math.min(...places) === 1 ? 'Vainqueur' : `${Math.min(...places)}e` }
      : furthest
        ? { place: null, label: furthest.result.label, round: furthest.result.round }
        : null,
  };
}

async function fencerSeason(db, userId, favoriteId, season = null) {
  if (season !== null && season !== 'all' && !SEASON.test(String(season)))
    throw failure('Saison invalide (ex. 2026-2027).', 400);
  const favorite = await db.followedFencer.findFirst({ where: { id: favoriteId, userId } });
  if (!favorite) throw failure('Tireur suivi introuvable.', 404);
  const competitions = await db.competition.findMany({
    where: { podiumFormat: 'INDIVIDUAL' },
    select: {
      id: true,
      name: true,
      createdAt: true,
      podiumFormat: true,
      podiumRoster: true,
      officialPodium: true,
      podiumResolvedAt: true,
      tournament: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const decorated = await require('./fencerAffiliations').decorate(db, competitions, [favorite]);
  // Orthographes reliées par l'administration : même tireur, autres noms d'inscription.
  const variants = await withAliases(db, decorated.favorites);
  // Nom d'inscription du tireur dans chaque épreuve où il est reconnu sans ambiguïté.
  const linked = [];
  for (const c of decorated.competitions) {
    const r = resolve(variants, c);
    const link = r.links.find((l) => l.favoriteId === favoriteId);
    const entry = link && (c.podiumRoster || []).find((e) => String(e.id) === link.entryId);
    if (entry && r.matchNames.includes(entry.name)) linked.push({ c, name: entry.name });
  }
  if (!linked.length)
    return {
      favorite: { id: favorite.id, name: favorite.name },
      seasons: [],
      season: null,
      summary: summarize([]),
      competitions: [],
    };
  const ids = linked.map((l) => l.c.id);
  const names = [...new Set(linked.map((l) => l.name))];
  const [matches, pools] = await Promise.all([
    db.match.findMany({
      where: {
        competitionId: { in: ids },
        isFinished: true,
        pointsPending: false,
        AND: [
          { OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] },
          {
            OR: names.flatMap((n) => [
              { player1: { equals: n, mode: 'insensitive' } },
              { player2: { equals: n, mode: 'insensitive' } },
            ]),
          },
        ],
      },
      orderBy: [{ startsAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    }),
    db.pool.findMany({
      where: {
        competitionId: { in: ids },
        fencers: { some: { OR: names.map((n) => ({ name: { equals: n, mode: 'insensitive' } })) } },
      },
      include: { fencers: true },
    }),
  ]);
  const same = (a, b) => normalize(a) === normalize(b);
  const entries = linked
    .map(({ c, name }) => {
      const own = matches.filter((m) => m.competitionId === c.id && (same(m.player1, name) || same(m.player2, name)));
      const ownPools = pools.filter((p) => p.competitionId === c.id && p.fencers.some((f) => same(f.name, name)));
      const { data } = competitionEntry(c, name, own, ownPools);
      // Épreuve terminée (podium officiel) sans poule ni match importés : engagé, détail indisponible.
      const finished = Boolean(c.podiumResolvedAt || c.officialPodium?.gold);
      return { ...data, season: seasonOf(data.date), finished };
    })
    // Épreuves à venir (inscrit, rien de disputé) : pas encore dans le bilan.
    .filter(
      (e) =>
        e.pools.some((p) => p.wins !== null || p.bouts.length) ||
        e.tableau.length ||
        e.result ||
        (e.detailMissing && e.finished),
    )
    .map(({ finished, ...e }) => e)
    .sort((a, b) => b.date.localeCompare(a.date));
  const seasons = [...new Set(entries.map((e) => e.season))].sort().reverse();
  const chosen = season === 'all' ? 'all' : season || seasons[0] || null;
  const shown = chosen === 'all' ? entries : entries.filter((e) => e.season === chosen);
  return {
    favorite: { id: favorite.id, name: favorite.name },
    seasons,
    season: chosen,
    summary: summarize(shown),
    competitions: shown,
  };
}

module.exports = { fencerSeason, seasonOf, summarize, withAliases };
