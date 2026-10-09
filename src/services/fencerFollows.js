const { createHash } = require('node:crypto');
const { countryFor } = require('./matchCountries');
const { failure } = require('./ftlClient');
const normalize = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 160) : '');
const entriesOf = (c) => (c?.podiumFormat === 'TEAM' ? [] : Array.isArray(c?.podiumRoster) ? c.podiumRoster : []);
function identity(entry) {
  const name = clean(entry.name);
  const rawCountry = clean(entry.nation || entry.country);
  const country = countryFor([{ name, country: rawCountry }], name) || '';
  // Les listes nationales Engarde/FTL portent parfois le club dans « country ».
  const club = clean(entry.club || (!country ? rawCountry : ''));
  return { name, country, club };
}
function keyFor(data) {
  const parts = [normalize(data.name), normalize(data.country), normalize(data.club)];
  if (!data.country && !data.club) parts.push(String(data.originCompetitionId), data.originEntryId);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function compatible(favorite, entry, competitionId) {
  const candidate = identity(entry);
  if (normalize(favorite.name) !== normalize(candidate.name)) return false;
  if (
    favorite.affiliationId &&
    favorite.affiliationId === entry.affiliationId &&
    (!favorite.country || !candidate.country || favorite.country === candidate.country)
  )
    return true;
  for (const field of ['country', 'club'])
    if (favorite[field] && candidate[field] && normalize(favorite[field]) !== normalize(candidate[field])) return false;
  if (favorite.originCompetitionId === competitionId && favorite.originEntryId === String(entry.id)) return true;
  // Une information connue disparue/apparue demande une confirmation par un nouveau suivi.
  if (Boolean(favorite.club) !== Boolean(candidate.club)) return false;
  if (favorite.country && candidate.country && favorite.country === candidate.country) return true;
  return Boolean(favorite.club && candidate.club && normalize(favorite.club) === normalize(candidate.club));
}
function resolve(favorites, competition, { includeMatchNames = true } = {}) {
  const roster = entriesOf(competition);
  const links = [],
    ambiguousIds = [];
  for (const f of favorites) {
    const candidates = roster.filter((e) => compatible(f, e, competition.id));
    const origin = candidates.filter(
      (e) => f.originCompetitionId === competition.id && String(e.id) === f.originEntryId,
    );
    const found = origin.length === 1 ? origin : candidates;
    if (found.length === 1) links.push({ entryId: String(found[0].id), favoriteId: f.id });
    else if (roster.some((e) => normalize(e.name) === normalize(f.name))) ambiguousIds.push(f.id);
  }
  // Les matchs n’ont qu’un nom : aucune étoile attribuée si ce nom désigne plusieurs engagés.
  const matchNames = (includeMatchNames ? roster : [])
    .filter(
      (e) =>
        links.some((l) => l.entryId === String(e.id)) &&
        roster.filter((other) => normalize(other.name) === normalize(e.name)).length === 1,
    )
    .map((e) => e.name);
  return { links, ambiguousIds, matchNames };
}
async function list(db, userId, competitionId) {
  let favorites = await db.followedFencer.findMany({ where: { userId }, orderBy: { id: 'asc' } });
  let competition = competitionId ? await db.competition.findUnique({ where: { id: competitionId } }) : null;
  if (competitionId && !competition) throw failure('Épreuve introuvable.', 404);
  const decorated = await require('./fencerAffiliations').decorate(db, competition ? [competition] : [], favorites);
  favorites = decorated.favorites;
  if (competition) competition = decorated.competitions[0];
  return {
    favorites,
    ...(competition ? resolve(favorites, competition) : { links: [], ambiguousIds: [], matchNames: [] }),
  };
}
function selections(competition) {
  const rows = entriesOf(competition)
    .filter((e) => e?.id != null && typeof e.name === 'string')
    .map((entry) => {
      const data = { ...identity(entry), originCompetitionId: competition.id, originEntryId: String(entry.id) };
      return { data, key: keyFor(data) };
    });
  const keyCounts = new Map(),
    idCounts = new Map();
  for (const { data, key } of rows) {
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    idCounts.set(data.originEntryId, (idCounts.get(data.originEntryId) || 0) + 1);
  }
  return new Map(
    rows
      .filter(({ data }) => idCounts.get(data.originEntryId) === 1)
      .map(({ data, key }) => [
        data.originEntryId,
        {
          ...data,
          identityKey:
            keyCounts.get(key) > 1
              ? createHash('sha256').update(`${key}:${competition.id}:${data.originEntryId}`).digest('hex')
              : key,
        },
      ]),
  );
}
function selected(competition, entryId) {
  const data = selections(competition).get(entryId);
  if (!data) throw failure('Tireur absent ou ambigu dans la liste officielle.', 409);
  return data;
}
async function locked(db, userId, fn) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    return fn(tx);
  });
}
async function save(tx, userId, data) {
  if (tx.fencerAffiliationEntry) {
    const link = await tx.fencerAffiliationEntry.findUnique({
      where: { competitionId_entryId: { competitionId: data.originCompetitionId, entryId: data.originEntryId } },
    });
    if (link) {
      const favorites = await tx.followedFencer.findMany({ where: { userId } });
      const origins = await tx.fencerAffiliationEntry.findMany({ where: { affiliationId: link.affiliationId } });
      const previous = favorites.find((f) =>
        origins.some((o) => o.competitionId === f.originCompetitionId && o.entryId === f.originEntryId),
      );
      if (previous) return previous;
    }
  }
  const existing = await tx.followedFencer.findUnique({
    where: { userId_identityKey: { userId, identityKey: data.identityKey } },
  });
  if (existing) return existing;
  if ((await tx.followedFencer.count({ where: { userId } })) >= 200)
    throw failure('Vous pouvez suivre au maximum 200 tireurs.', 409);
  return tx.followedFencer.create({ data: { ...data, userId } });
}
async function follow(db, userId, competitionId, entryId) {
  return locked(db, userId, async (tx) => {
    const c = await tx.competition.findUnique({ where: { id: competitionId } });
    if (!c) throw failure('Épreuve introuvable.', 404);
    return save(tx, userId, selected(c, entryId));
  });
}
async function importLocal(db, userId, items) {
  return locked(db, userId, async (tx) => {
    const competitions = await tx.competition.findMany({
      where: { podiumFormat: 'INDIVIDUAL' },
      select: { id: true, podiumRoster: true, podiumFormat: true },
    });
    const unresolved = [],
      imported = [];
    for (const [index, item] of items.entries()) {
      const candidates = competitions.flatMap((c) =>
        entriesOf(c)
          .filter(
            (e) =>
              String(e.id) === String(item.id) &&
              normalize(e.name) === normalize(item.name) &&
              (!item.country || normalize(e.country) === normalize(item.country)),
          )
          .map((e) => selected(c, String(e.id))),
      );
      const keys = new Set(candidates.map((c) => c.identityKey));
      if (keys.size !== 1) {
        unresolved.push(index);
        continue;
      }
      imported.push((await save(tx, userId, candidates[0])).id);
    }
    return { imported: [...new Set(imported)], unresolved };
  });
}
module.exports = { normalize, identity, keyFor, compatible, resolve, list, follow, importLocal, selections };
