// Liste des engagés engarde-service : engarde ne publie pas d'identifiant, celui de l'application vient
// du nom (et du club). Un nom corrigé en cours de journée (« PINEIRA Enzo » → « MOUREY PINEIRA Enzo »,
// « ROSSI Nicolo » → « ROSSI Nicolo' ») garde son identifiant : les pronostics de podium suivent.
const { clean } = require('./engardeParser');
const { failure } = require('./ftlClient');

const norm = (s) => clean(s).toLowerCase();
const tokens = (name) =>
  new Set(
    clean(name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’.-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
const inside = (a, b) => [...a].every((t) => b.has(t));
// Même personne, nom corrigé : même nation/club quand les deux sont connus, et tous les mots du nom
// le plus court (au moins deux) présents dans l'autre.
function sameFencer(a, b) {
  if (a.country && b.country && norm(a.country) !== norm(b.country)) return false;
  const ta = tokens(a.name),
    tb = tokens(b.name);
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return small.size >= 2 && inside(small, large);
}

// Fusion pure : renvoie la liste fusionnée et les renommages (identifiant conservé).
function mergeRoster(current = [], observed = []) {
  // Une identité contradictoire exige une vérification admin ; conserver la liste précédente.
  for (const e of current) {
    const byId = observed.find((o) => o.id === e.id);
    const byName = observed.filter((o) => norm(o.name) === norm(e.name));
    const candidate = byId || (byName.length === 1 ? byName[0] : null);
    if (candidate && e.country && candidate.country && norm(e.country) !== norm(candidate.country))
      throw failure(`Identité à confirmer par un administrateur : ${e.name} (nation ou club différent).`, 409);
  }
  const used = new Set();
  const matchOf = new Map(); // id courant → entrée observée
  for (const e of current) {
    const o = observed.find((x) => !used.has(x) && x.id === e.id);
    if (o) {
      matchOf.set(e.id, o);
      used.add(o);
    }
  }
  for (const e of current) {
    if (matchOf.has(e.id)) continue;
    const hits = observed.filter((x) => !used.has(x) && norm(x.name) === norm(e.name));
    if (hits.length === 1) {
      matchOf.set(e.id, hits[0]);
      used.add(hits[0]);
    }
  }
  // Renommages : appariement un pour un entre engagés disparus et nouveaux noms.
  const renames = [];
  const missing = current.filter((e) => !matchOf.has(e.id));
  const fresh = observed.filter((o) => !used.has(o));
  for (const e of missing) {
    const candidates = fresh.filter((o) => !used.has(o) && sameFencer(e, o));
    if (candidates.length !== 1) continue;
    const o = candidates[0];
    if (missing.filter((x) => !matchOf.has(x.id) && sameFencer(x, o)).length !== 1) continue;
    matchOf.set(e.id, o);
    used.add(o);
    renames.push({ id: e.id, from: e.name, to: o.name });
  }
  const merged = [
    ...current.map((e) => {
      const o = matchOf.get(e.id);
      if (!o) return { ...e, active: false };
      return {
        ...e,
        name: o.name,
        country: o.country || e.country || '',
        entryRanking: o.entryRanking ?? e.entryRanking ?? null,
        active: true,
      };
    }),
    ...observed.filter((o) => !used.has(o)),
  ].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return { merged, renames };
}

// Engagé d'un nom donné ; homonymes départagés par la nation ou le club publié à côté du nom.
function entryFor(roster, name, club = '') {
  const hits = (roster || []).filter((e) => norm(e.name) === norm(name));
  if (hits.length === 1) return club && hits[0].country && norm(hits[0].country) !== norm(club) ? null : hits[0];
  if (!club) return null;
  const byClub = hits.filter((e) => e.country && norm(e.country) === norm(club));
  if (byClub.length === 1) return byClub[0];
  const active = byClub.filter((e) => e.active !== false);
  return active.length === 1 ? active[0] : null;
}

// Une poule déjà importée ne stocke pas le club : son numéro et sa composition officielle
// inchangée permettent de retrouver l'identité. Sinon, conserver le blocage de sécurité.
function overlapsPool(pool, observed, allObserved, roster, url) {
  const source =
    pool.sourceUrl === url ? allObserved.find((o) => !o.error && o.number === pool.sourcePoolNumber) : null;
  const aligned =
    source &&
    pool.fencers.length === source.rows.length &&
    pool.fencers.every((f, i) => f.position === source.rows[i].position && norm(f.name) === norm(source.rows[i].name));
  return pool.fencers.some((f, i) =>
    observed.rows.some((r) => {
      if (norm(f.name) !== norm(r.name)) return false;
      if (!aligned) return true;
      const storedEntry = entryFor(roster, source.rows[i].name, source.rows[i].club);
      const incomingEntry = entryFor(roster, r.name, r.club);
      return !storedEntry?.id || !incomingEntry?.id || storedEntry.id === incomingEntry.id;
    }),
  );
}

module.exports = { mergeRoster, entryFor, sameFencer, overlapsPool };
