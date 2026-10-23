// Regroupement de lecture uniquement : aucun profil ni favori n'est fusionné en base.
const norm = (v) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
const nameKey = (v) =>
  norm(v)
    .replace(/[’'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const select = {
  id: true,
  name: true,
  nameKey: true,
  country: true,
  club: true,
  birthYear: true,
  federationVerified: true,
  federationKey: true,
  entries: { select: { competitionId: true, entryId: true } },
};
function groups(profiles) {
  const buckets = new Map(),
    people = new Map(),
    result = new Map();
  for (const p of profiles) {
    result.set(p.id, p.id);
    if (!p.country) continue;
    const personKey = JSON.stringify([norm(p.name), norm(p.country)]);
    if (!people.has(personKey)) people.set(personKey, []);
    people.get(personKey).push(p);
    // Un club absent n'est pas supposé égal à un club connu.
    const key = JSON.stringify([norm(p.name), norm(p.country), norm(p.club)]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  for (const rows of buckets.values()) {
    const candidates = people.get(JSON.stringify([norm(rows[0].name), norm(rows[0].country)]));
    const knownYears = new Set(candidates.map((p) => p.birthYear).filter(Number.isInteger));
    const knownClubs = new Set(candidates.map((p) => norm(p.club)).filter(Boolean));
    // Un profil provisoire ne doit pas contourner une ambiguïté fédérale déjà connue,
    // même si l'un des homonymes n'a pas de club ou représente un autre club.
    if (
      candidates.filter((p) => p.federationVerified).length > 1 ||
      knownYears.size > 1 ||
      (!norm(rows[0].club) && knownClubs.size > 1)
    )
      continue;

    const years = new Set(rows.map((p) => p.birthYear).filter(Number.isInteger));
    const verified = rows.filter((p) => p.federationVerified);
    const events = new Map();
    for (const p of rows)
      for (const e of p.entries || []) {
        if (!events.has(e.competitionId)) events.set(e.competitionId, new Set());
        events.get(e.competitionId).add(String(e.entryId));
      }
    // Plusieurs engagés dans une même épreuve, années ou identités fédérales contradictoires : séparation.
    if (years.size > 1 || verified.length > 1 || [...events.values()].some((ids) => ids.size > 1)) continue;
    const canonical = verified[0]?.id || Math.min(...rows.map((p) => p.id));
    for (const p of rows) result.set(p.id, canonical);
  }
  return result;
}
async function load(db, names, ids = []) {
  if (!db.fencerAffiliation) return { profiles: [], groups: new Map() };
  const profiles = await db.fencerAffiliation.findMany({
    where: { OR: [{ nameKey: { in: [...new Set(names.map(nameKey))] } }, { id: { in: ids } }] },
    select,
  });
  return { profiles, groups: groups(profiles) };
}
async function equivalent(db, profile) {
  const data = await load(db, [profile.name], [profile.id]);
  const canonical = data.groups.get(profile.id) || profile.id;
  const ids = [...data.groups].filter(([, value]) => value === canonical).map(([id]) => id);
  return { canonical, ids: ids.length ? ids : [profile.id], profiles: data.profiles };
}
module.exports = { groups, load, equivalent, select };
