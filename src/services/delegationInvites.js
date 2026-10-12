// Invitations par nom d'utilisateur dans une délégation d'amis : tout membre actif peut inviter,
// la personne invitée accepte ou refuse. Personne n'entre dans une délégation sans l'avoir choisi.
const { fail } = require('./poolRules');
const { enroll } = require('./groups');

const MAX_PENDING = 50;
const activeMember = (tx, leagueId, userId) =>
  tx.leagueMember.findFirst({ where: { leagueId, userId, leftAt: null }, select: { id: true } });

// Nom exact d'abord, puis sans tenir compte des majuscules s'il n'y a qu'une seule correspondance.
async function userByName(tx, raw) {
  const name = String(raw || '').trim();
  if (!name) fail('Indiquez le nom d’utilisateur de la personne à inviter.');
  const exact = await tx.user.findUnique({ where: { name }, select: { id: true, name: true } });
  if (exact) return exact;
  const close = await tx.user.findMany({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 2,
  });
  if (close.length !== 1) fail('Aucun joueur avec ce nom d’utilisateur.', 404);
  return close[0];
}

async function invite(tx, leagueId, inviterId, username) {
  const league = await tx.league.findUnique({ where: { id: leagueId } });
  if (!league || league.archivedAt || !(await activeMember(tx, leagueId, inviterId))) fail('Ce groupe est privé.', 403);
  if (league.kind !== 'PRIVATE') fail('Les membres d’un club se gèrent depuis Mon compte.', 403);
  const user = await userByName(tx, username);
  if (user.id === inviterId) fail('Vous êtes déjà membre de cette délégation.');
  if (await activeMember(tx, leagueId, user.id)) fail(`${user.name} est déjà membre de cette délégation.`, 409);
  const existing = await tx.leagueInvitation.findUnique({
    where: { leagueId_userId: { leagueId, userId: user.id } },
  });
  if (existing) fail(`${user.name} a déjà une invitation en attente pour cette délégation.`, 409);
  if ((await tx.leagueInvitation.count({ where: { leagueId } })) >= MAX_PENDING)
    fail('Trop d’invitations en attente pour cette délégation.', 429);
  await tx.leagueInvitation.create({ data: { leagueId, userId: user.id, invitedById: inviterId } });
  return { name: user.name };
}

// Invitations reçues encore valables (délégation d'amis toujours active).
async function received(tx, userId) {
  const rows = await tx.leagueInvitation.findMany({
    where: { userId, league: { archivedAt: null, kind: 'PRIVATE' } },
    include: {
      league: { select: { id: true, name: true, _count: { select: { members: { where: { leftAt: null } } } } } },
    },
    orderBy: { id: 'desc' },
  });
  const inviters = await tx.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.invitedById))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(inviters.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    league: { id: r.league.id, name: r.league.name, members: r.league._count.members },
    invitedBy: nameOf.get(r.invitedById) || null,
    createdAt: r.createdAt,
  }));
}

async function mine(tx, invitationId, userId) {
  const invitation = await tx.leagueInvitation.findUnique({ where: { id: invitationId }, include: { league: true } });
  if (!invitation || invitation.userId !== userId) fail('Invitation introuvable.', 404);
  return invitation;
}

async function accept(tx, invitationId, userId) {
  const { league } = await mine(tx, invitationId, userId);
  await tx.leagueInvitation.delete({ where: { id: invitationId } });
  if (league.archivedAt || league.kind !== 'PRIVATE') fail('Cette délégation n’existe plus.', 404);
  if (!(await activeMember(tx, league.id, userId))) await enroll(tx, league, userId);
  return { id: league.id, name: league.name };
}

async function decline(tx, invitationId, userId) {
  await mine(tx, invitationId, userId);
  await tx.leagueInvitation.delete({ where: { id: invitationId } });
}

// Entrée par le code d'invitation : l'invitation nominative éventuelle n'a plus lieu d'être.
const clear = (tx, leagueId, userId) => tx.leagueInvitation.deleteMany({ where: { leagueId, userId } });

module.exports = { invite, received, accept, decline, clear, MAX_PENDING };
