// Le club de l'application : son nom et ses tireurs, mis en avant sur les matchs et les poules,
// et une ligue « club » créée automatiquement pour chaque tournoi (membres reconduits d'un tournoi à l'autre).
const crypto = require('node:crypto');
const { failure } = require('./ftlClient');

const KEY = 'club';
const EMPTY = { name: '', fencers: [] };
// « SAVIN Rafael », « Savin  Rafaël » → même tireur (casse, accents et espaces ignorés).
const normalizeName = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

async function getClub(db) {
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  return { ...EMPTY, ...(row?.value || {}) };
}

function validateClub(input) {
  const name = String(input?.name || '')
    .normalize('NFC')
    .trim();
  if (name.length > 60) throw failure('Nom du club : 60 caractères au plus.', 400);
  const raw = Array.isArray(input?.fencers) ? input.fencers : String(input?.fencers || '').split('\n');
  const seen = new Set();
  const fencers = [];
  for (const f of raw) {
    const clean = String(f || '')
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) continue;
    if (clean.length > 80) throw failure(`Nom trop long : « ${clean.slice(0, 30)}… ».`, 400);
    if (seen.has(normalizeName(clean))) continue;
    seen.add(normalizeName(clean));
    fencers.push(clean);
  }
  if (fencers.length > 300) throw failure('300 tireurs au plus.', 400);
  return { name, fencers };
}

async function saveClub(db, input, actorId) {
  const club = validateClub(input);
  const before = await getClub(db);
  await db.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: club }, update: { value: club } });
  await db.auditLog.create({
    data: { actorId, action: 'Club et tireurs mis à jour', targetType: 'Club', targetId: 0, before, after: club },
  });
  return club;
}

// Début d'un tournoi : premier horaire connu (match, ou début d'épreuve FencingTimeLive).
async function tournamentStart(db, tournament) {
  const times = [];
  const first = await db.match.findFirst({
    where: { competition: { tournamentId: tournament.id }, startsAt: { not: null } },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true },
  });
  if (first?.startsAt) times.push(new Date(first.startsAt).getTime());
  const { eventStartFor } = require('./eventStart');
  for (const c of tournament.competitions || []) {
    const start = await eventStartFor(db, c.id);
    if (start) times.push(start);
  }
  return times.length ? new Date(Math.min(...times)) : null;
}

// Crée la ligue du club des tournois non archivés qui n'en ont pas encore, et y reconduit les membres
// de la dernière ligue du club. Sans effet tant que le nom du club n'est pas renseigné.
async function ensureClubLeagues(db, { now = new Date(), actorId = null } = {}) {
  const club = await getClub(db);
  if (!club.name) return [];
  const tournaments = await db.tournament.findMany({
    where: { archivedAt: null },
    include: { competitions: { select: { id: true } } },
  });
  const created = [];
  for (const t of tournaments) {
    const existing = await db.league.findFirst({ where: { tournamentId: t.id, kind: 'CLUB', name: club.name } });
    if (existing) continue;
    const startsAt = await tournamentStart(db, t);
    if (!startsAt || startsAt <= now) continue; // horaire inconnu ou tournoi commencé : inscriptions impossibles
    const owner =
      actorId ||
      (await db.user.findFirst({ where: { isAdmin: true }, orderBy: { id: 'asc' }, select: { id: true } }))?.id;
    if (!owner) continue;
    const league = await db.league.create({
      data: {
        name: club.name,
        kind: 'CLUB',
        tournamentId: t.id,
        startsAt,
        ownerId: owner,
        code: crypto.randomBytes(12).toString('hex').toUpperCase(),
      },
    });
    // Membres de la ligue du club la plus récente : reconduits (sauf s'ils ont déjà un club pour ce tournoi).
    const previous = await db.league.findFirst({
      where: { kind: 'CLUB', name: club.name, NOT: { id: league.id } },
      orderBy: { id: 'desc' },
      include: { members: true },
    });
    let carried = 0;
    for (const m of previous?.members || []) {
      const other = await db.leagueMember.findFirst({
        where: { userId: m.userId, league: { kind: 'CLUB', tournamentId: t.id } },
      });
      if (other) continue;
      await db.leagueMember.create({ data: { leagueId: league.id, userId: m.userId } });
      carried++;
    }
    created.push({ tournamentId: t.id, leagueId: league.id, carried });
  }
  return created;
}

module.exports = { getClub, saveClub, validateClub, normalizeName, ensureClubLeagues, tournamentStart };
