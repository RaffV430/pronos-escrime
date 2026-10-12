// Orthographes d'un même tireur (« MARTIN Lea » / « MARTIN Léa », nom composé…) reliées par
// l'administration : l'historique du tireur (fiche, « Toutes ses épreuves », parcours) les réunit.
// Rangées dans AppSetting (pas de nouvelle table) : quelques dizaines de liens au plus.
const { failure } = require('./ftlClient');
const KEY = 'fencer-aliases';
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
const clean = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();

async function groups(db) {
  if (!db.appSetting) return [];
  const row = await db.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  return Array.isArray(row?.value) ? row.value.filter((g) => Array.isArray(g?.names) && g.names.length > 1) : [];
}

// Toutes les orthographes reliées à un nom (le nom lui-même compris).
function expandWith(list, name) {
  const key = norm(name);
  const group = list.find((g) => g.names.some((n) => norm(n) === key));
  return group ? [...new Set([clean(name), ...group.names])] : [clean(name)];
}
async function expand(db, name) {
  return expandWith(await groups(db), name);
}

// Nombre d'apparitions d'une orthographe (engagés, poules, tableau) : on ne relie que des noms connus.
async function occurrences(db, name) {
  const eq = { equals: name, mode: 'insensitive' };
  const [matches, pools] = await Promise.all([
    db.match.count({ where: { OR: [{ player1: eq }, { player2: eq }] } }),
    db.poolFencer.count({ where: { name: eq } }),
  ]);
  return matches + pools;
}

async function link(db, actorId, a, b) {
  const [first, second] = [clean(a), clean(b)];
  if (first.length < 3 || second.length < 3 || first.length > 120 || second.length > 120)
    throw failure('Deux noms de tireur sont requis.', 400);
  if (norm(first) === norm(second)) throw failure('Ces deux orthographes sont déjà reconnues comme identiques.', 409);
  for (const n of [first, second])
    if (!(await occurrences(db, n))) throw failure(`« ${n} » n’apparaît dans aucune poule ni aucun match suivi.`, 404);
  const list = await groups(db);
  const ga = list.find((g) => g.names.some((n) => norm(n) === norm(first)));
  const gb = list.find((g) => g.names.some((n) => norm(n) === norm(second)));
  let next;
  if (ga && ga === gb) throw failure('Ces deux orthographes sont déjà reliées.', 409);
  const merged = {
    names: [...new Set([...(ga?.names || [first]), ...(gb?.names || [second])])],
    updatedAt: new Date().toISOString(),
    actorId,
  };
  next = [...list.filter((g) => g !== ga && g !== gb), merged];
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
  await db.auditLog.create({
    data: {
      actorId,
      action: 'Orthographes de tireur reliées',
      targetType: 'Fencer',
      targetId: 0,
      after: { names: merged.names },
    },
  });
  return merged;
}

async function unlink(db, actorId, name) {
  const list = await groups(db);
  const group = list.find((g) => g.names.some((n) => norm(n) === norm(name)));
  if (!group) throw failure('Aucun lien pour ce nom.', 404);
  const rest = group.names.filter((n) => norm(n) !== norm(name));
  const next = list.filter((g) => g !== group).concat(rest.length > 1 ? [{ ...group, names: rest }] : []);
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
  await db.auditLog.create({
    data: { actorId, action: 'Orthographe de tireur détachée', targetType: 'Fencer', targetId: 0, after: { name } },
  });
  return { names: rest };
}

module.exports = { groups, expand, expandWith, link, unlink, norm, occurrences };
