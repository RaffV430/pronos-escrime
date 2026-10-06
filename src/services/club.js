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

module.exports = { getClub, saveClub, validateClub, normalizeName, tournamentStart };
