// Groupes d'amis et clubs permanents : un groupe garde ses membres d'un tournoi à l'autre ; son
// classement se lit sur un tournoi ou sur toute la saison.
//  - Groupe d'amis : les membres actuels, avec tous leurs points (même ceux d'avant l'inscription).
//  - Club : les membres au début du tournoi (inscriptions et départs figés pendant un tournoi) ;
//    note du club = moyenne de ses membres ; 3 membres au moins ; un seul club à la fois.
const { failure } = require('./ftlClient');

const active = (m) => !m.leftAt;

// Membres du club pour un tournoi : présents à son début ; avant le début (ou sans horaire), les membres actuels.
function clubMembersAt(members, start, now = Date.now()) {
  const t = start ? new Date(start).getTime() : null;
  if (!t || t > now) return members.filter(active);
  return members.filter((m) => new Date(m.joinedAt).getTime() <= t && (!m.leftAt || new Date(m.leftAt).getTime() > t));
}

// Membres comptés pour un classement : groupe d'amis = actuels ; club = au début du tournoi choisi.
function membersFor(league, { start = null, tournamentId = null, now = Date.now() } = {}) {
  if (league.kind !== 'CLUB' || !tournamentId) return league.members.filter(active);
  return clubMembersAt(league.members, start, now);
}

// Inscription (ou retour après un départ). Un seul club actif par joueur.
async function enroll(tx, league, userId) {
  if (league.archivedAt) throw failure('Ce groupe n’existe plus.', 404);
  if (league.kind === 'CLUB') {
    const other = await tx.leagueMember.findFirst({
      where: {
        userId,
        leftAt: null,
        leagueId: { not: league.id },
        league: { kind: 'CLUB', archivedAt: null },
      },
      include: { league: { select: { name: true } } },
    });
    if (other) throw failure(`Un seul club à la fois : quittez d’abord « ${other.league.name} ».`, 409);
  }
  return tx.leagueMember.upsert({
    where: { leagueId_userId: { leagueId: league.id, userId } },
    update: { leftAt: null },
    create: { leagueId: league.id, userId },
  });
}

async function leave(tx, league, userId, now = new Date()) {
  await tx.leagueMember.updateMany({ where: { leagueId: league.id, userId, leftAt: null }, data: { leftAt: now } });
}

// Ligue du club de l'application : une seule, permanente. Les anciennes ligues par tournoi sont
// fusionnées dans la plus récente (membres réunis, première date d'inscription conservée).
async function ensureAppClub(db, { actorId = null } = {}) {
  const { getClub } = require('./club');
  const club = await getClub(db);
  if (!club.name) return null;
  const all = await db.league.findMany({
    where: { kind: 'CLUB', name: club.name, archivedAt: null },
    include: { members: true },
    orderBy: { id: 'desc' },
  });
  if (!all.length) {
    const owner =
      actorId ||
      (await db.user.findFirst({ where: { isAdmin: true }, orderBy: { id: 'asc' }, select: { id: true } }))?.id;
    if (!owner) return null;
    return db.league.create({
      data: {
        name: club.name,
        kind: 'CLUB',
        tournamentId: null,
        startsAt: new Date(),
        ownerId: owner,
        code: require('crypto').randomBytes(12).toString('hex').toUpperCase(),
      },
    });
  }
  const [keep, ...older] = all;
  if (!older.length) return keep;
  const first = new Map();
  for (const l of all)
    for (const m of l.members) {
      const prev = first.get(m.userId);
      if (!prev || new Date(m.joinedAt) < new Date(prev.joinedAt)) first.set(m.userId, m);
    }
  await db.$transaction(async (tx) => {
    for (const [userId, m] of first) {
      const current = keep.members.find((x) => x.userId === userId);
      if (current)
        await tx.leagueMember.update({
          where: { id: current.id },
          data: { joinedAt: m.joinedAt, ...(current.leftAt && !m.leftAt ? { leftAt: null } : {}) },
        });
      else
        await tx.leagueMember.create({
          data: { leagueId: keep.id, userId, joinedAt: m.joinedAt, leftAt: m.leftAt || null },
        });
    }
    await tx.league.updateMany({ where: { id: { in: older.map((l) => l.id) } }, data: { archivedAt: new Date() } });
  });
  return keep;
}

// Plusieurs clubs actifs pour un même joueur (ancien fonctionnement par tournoi) : seul le plus récent
// reste actif ; le départ des autres est daté d'aujourd'hui, ce qui garde les classements passés.
async function singleClubPerPlayer(db, now = new Date()) {
  const rows = await db.leagueMember.findMany({
    where: { leftAt: null, league: { kind: 'CLUB', archivedAt: null } },
    orderBy: [{ userId: 'asc' }, { joinedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, userId: true },
  });
  const seen = new Set(),
    extra = [];
  for (const r of rows) {
    if (seen.has(r.userId)) extra.push(r.id);
    seen.add(r.userId);
  }
  if (extra.length) await db.leagueMember.updateMany({ where: { id: { in: extra } }, data: { leftAt: now } });
  return extra.length;
}

module.exports = { active, clubMembersAt, membersFor, enroll, leave, ensureAppClub, singleClubPerPlayer };
