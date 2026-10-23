const { normalize, identity, selections, resolve } = require('./fencerFollows');
const { failure } = require('./ftlClient');
const { key: clubKey } = require('./accountClubs');

// Réutiliser les identités des favoris : une identité incomplète ou un homonyme
// dans une même liste officielle ne doit jamais être fusionné par son seul nom.
function directory(competitions, favorites, club, profiles = []) {
  const groups = new Map();
  for (const c of competitions) {
    if (c.podiumFormat === 'TEAM') continue;
    const links = resolve(favorites, c, { includeMatchNames: false }).links;
    const selectable = selections(c);
    for (const entry of Array.isArray(c.podiumRoster) ? c.podiumRoster : []) {
      if (entry?.id == null || !entry.name) continue;
      const key = entry.affiliationId
        ? `profile:${entry.participationGroupId || entry.affiliationId}`
        : selectable.get(String(entry.id))?.identityKey;
      if (!key) continue;
      if (!groups.has(key))
        groups.set(key, {
          ...entry,
          ...identity(entry),
          ...(entry.currentClub ? { club: entry.currentClub } : {}),
          affiliationId: entry.participationGroupId || entry.affiliationId,
          key,
          competitionId: c.id,
          events: [],
          favoriteId: null,
        });
      const row = groups.get(key);
      if (!row.ageCategory && entry.ageCategory) row.ageCategory = entry.ageCategory;
      if (!row.events.some((e) => e.id === c.id)) row.events.push({ id: c.id, name: c.name });
      row.favoriteId ||= links.find((l) => l.entryId === String(entry.id))?.favoriteId || null;
    }
  }
  const participation = require('./fencerParticipationGroups').groups(profiles);
  for (const p of [...profiles].sort((a, b) => a.id - b.id)) {
    const canonical = participation.get(p.id) || p.id;
    const key = `profile:${canonical}`;
    const row = groups.get(key) || { id: null, competitionId: null, events: [], favoriteId: null };
    groups.set(key, {
      ...row,
      key,
      affiliationId: canonical,
      name: p.name,
      country: p.country,
      club: p.club,
      ageCategory: row.ageCategory || require('./fencerAgeCategory').verifiedCategory(p),
      favoriteId:
        row.favoriteId ||
        favorites.find((f) => (participation.get(f.affiliationId) || f.affiliationId) === canonical)?.id ||
        null,
    });
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
async function search(db, userId, { tournamentId, competitionId, query, clubOnly, clubId, category, offset }) {
  if (tournamentId) {
    const tournament = await db.tournament.findUnique({ where: { id: tournamentId }, select: { id: true } });
    if (!tournament) throw failure('Tournoi introuvable.', 404);
  }
  const [competitions, favorites, profile, clubs] = await Promise.all([
    db.competition.findMany({
      where: tournamentId ? { tournamentId } : {},
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
  const decorated = await require('./fencerAffiliations').decorate(db, competitions, favorites, {
    groupAllEntries: true,
  });
  const profiles =
    !tournamentId && db.fencerAffiliation
      ? await db.fencerAffiliation.findMany({
          select: require('./fencerParticipationGroups').select,
        })
      : [];
  const rows = directory(decorated.competitions, decorated.favorites, selectedClub, profiles).filter(
    (row) =>
      (!competitionId || row.events.some((e) => e.id === competitionId)) &&
      (!category || row.ageCategory === category) &&
      (!(clubOnly || clubId) || row.isClub) &&
      (!term || normalize(`${row.name} ${row.club} ${row.country}`).includes(term)),
  );
  const eligible = term.length >= 2 || clubOnly || Boolean(clubId) || Boolean(category);
  return {
    events: competitions.filter((c) => c.podiumFormat !== 'TEAM').map(({ id, name }) => ({ id, name })),
    categories: require('./fencerAgeCategory').categories.slice(6),
    clubName: club.name,
    clubs: clubs.map(({ id, name, shortName }) => ({ id, name, shortName })),
    missingClubData: competitions.some((c) => (c.podiumRoster || []).some((f) => !f.club)),
    total: eligible ? rows.length : 0,
    results: eligible ? rows.slice(offset, offset + 20) : [],
    nextOffset: eligible && offset + 20 < rows.length ? offset + 20 : null,
  };
}
module.exports = { directory, search };
