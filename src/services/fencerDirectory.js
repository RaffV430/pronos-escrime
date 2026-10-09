const { normalize, identity, selections, resolve } = require('./fencerFollows');
const { failure } = require('./ftlClient');
const { key: clubKey } = require('./accountClubs');

// Réutiliser les identités des favoris : une identité incomplète ou un homonyme
// dans une même liste officielle ne doit jamais être fusionné par son seul nom.
function directory(competitions, favorites, club) {
  const groups = new Map();
  for (const c of competitions) {
    if (c.podiumFormat === 'TEAM') continue;
    const links = resolve(favorites, c, { includeMatchNames: false }).links;
    const selectable = selections(c);
    for (const entry of Array.isArray(c.podiumRoster) ? c.podiumRoster : []) {
      if (entry?.id == null || !entry.name) continue;
      const key = selectable.get(String(entry.id))?.identityKey;
      if (!key) continue;
      if (!groups.has(key))
        groups.set(key, {
          ...entry,
          ...identity(entry),
          ...(entry.currentClub ? { club: entry.currentClub } : {}),
          key,
          competitionId: c.id,
          events: [],
          favoriteId: null,
        });
      const row = groups.get(key);
      if (!row.events.some((e) => e.id === c.id)) row.events.push({ id: c.id, name: c.name });
      row.favoriteId ||= links.find((l) => l.entryId === String(entry.id))?.favoriteId || null;
    }
  }
  const rows = [...groups.values()];
  const nameCounts = new Map();
  for (const row of rows) nameCounts.set(normalize(row.name), (nameCounts.get(normalize(row.name)) || 0) + 1);
  const names = new Set((club.fencers || []).map(normalize));
  return rows
    .map((row) => ({
      ...row,
      isClub: Boolean(
        (row.club &&
          club.name &&
          [club.name, club.shortName].filter(Boolean).some((name) => clubKey(row.club) === clubKey(name))) ||
        (names.has(normalize(row.name)) && nameCounts.get(normalize(row.name)) === 1),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.key.localeCompare(b.key));
}
async function search(db, userId, { tournamentId, competitionId, query, clubOnly, clubId, offset }) {
  const tournament = await db.tournament.findUnique({ where: { id: tournamentId }, select: { id: true } });
  if (!tournament) throw failure('Tournoi introuvable.', 404);
  const [competitions, favorites, profile, clubs] = await Promise.all([
    db.competition.findMany({
      where: { tournamentId },
      select: { id: true, name: true, podiumFormat: true, podiumRoster: true },
      orderBy: { id: 'asc' },
    }),
    db.followedFencer.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    db.user.findUnique({ where: { id: userId }, select: { club: true } }),
    db.club.findMany({ orderBy: { name: 'asc' } }),
  ]);
  if (competitionId && !competitions.some((c) => c.id === competitionId))
    throw failure('Épreuve absente de ce tournoi.', 400);
  const club = profile?.club || { name: '', fencers: [] };
  const selectedClub = clubId ? clubs.find((c) => c.id === clubId) : club;
  if (clubId && !selectedClub) throw failure('Club introuvable.', 404);
  const term = normalize(query);
  const decorated = await require('./fencerAffiliations').decorate(db, competitions, favorites);
  const rows = directory(decorated.competitions, decorated.favorites, selectedClub).filter(
    (row) =>
      (!competitionId || row.events.some((e) => e.id === competitionId)) &&
      (!(clubOnly || clubId) || row.isClub) &&
      (!term || normalize(`${row.name} ${row.club} ${row.country}`).includes(term)),
  );
  const eligible = term.length >= 2 || clubOnly || Boolean(clubId);
  return {
    events: competitions.filter((c) => c.podiumFormat !== 'TEAM').map(({ id, name }) => ({ id, name })),
    clubName: club.name,
    clubs: clubs.map(({ id, name, shortName }) => ({ id, name, shortName })),
    missingClubData: competitions.some((c) => (c.podiumRoster || []).some((f) => !f.club)),
    total: eligible ? rows.length : 0,
    results: eligible ? rows.slice(offset, offset + 20) : [],
    nextOffset: eligible && offset + 20 < rows.length ? offset + 20 : null,
  };
}
module.exports = { directory, search };
