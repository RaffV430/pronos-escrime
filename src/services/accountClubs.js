const crypto = require('crypto');
const { failure } = require('./ftlClient');
const groups = require('./groups');
const key = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const clean = (value, min, max, label) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw failure(`${label} invalide.`, 400);
  return value.trim().normalize('NFC');
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
// Serialize registry linking and membership changes, including simultaneous signups.
async function lock(tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(72610309)::text`;
}
async function findOrCreate(tx, input) {
  if (positive(input.clubId)) {
    const club = await tx.club.findUnique({ where: { id: input.clubId } });
    if (!club) throw failure('Club introuvable.', 404);
    return club;
  }
  const name = clean(input.name, 2, 120, 'Nom du club');
  const city = clean(input.city, 2, 100, 'Ville');
  const shortName = clean(input.shortName || '', 0, 40, 'Abréviation');
  const nameKey = key(name);
  if (!nameKey) throw failure('Nom du club invalide.', 400);
  const clubs = await tx.club.findMany();
  const candidates = clubs.filter(
    (c) =>
      c.nameKey === nameKey ||
      (key(c.shortName) && key(c.shortName) === nameKey) ||
      (key(shortName) && key(c.shortName) === key(shortName)),
  );
  if (candidates.length > 1) throw failure('Plusieurs clubs correspondent. Choisissez un club dans la liste.', 409);
  if (candidates.length) return candidates[0];
  return tx.club.create({ data: { name, nameKey, city, shortName } });
}
async function leagueFor(tx, club, actorId) {
  if (club.leagueId) {
    const league = await tx.league.findUnique({ where: { id: club.leagueId } });
    if (!league || league.archivedAt) throw failure('Club indisponible. Contactez un administrateur.', 409);
    return league;
  }
  const aliases = new Set([club.nameKey, key(club.shortName)].filter(Boolean));
  const candidates = (
    await tx.league.findMany({ where: { kind: 'CLUB', archivedAt: null }, include: { registeredClub: true } })
  ).filter((l) => aliases.has(key(l.name)) && (!l.registeredClub || l.registeredClub.id === club.id));
  if (candidates.length > 1)
    throw failure('Plusieurs groupes correspondent à ce club. Un administrateur doit les vérifier.', 409);
  const league =
    candidates[0] ||
    (await tx.league.create({
      data: {
        name: club.name,
        kind: 'CLUB',
        ownerId: actorId,
        startsAt: new Date(),
        code: crypto.randomBytes(12).toString('hex').toUpperCase(),
      },
    }));
  await tx.club.update({ where: { id: club.id }, data: { leagueId: league.id } });
  return league;
}
async function setClubInTransaction(tx, userId, input) {
  await lock(tx);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
  if (!input || (input.none !== true && !positive(input.clubId) && typeof input.name !== 'string'))
    throw failure('Choisissez un club ou « sans club ». ', 400);
  const club = input.none === true ? null : await findOrCreate(tx, input);
  const league = club ? await leagueFor(tx, club, userId) : null;
  const previous = await tx.leagueMember.findMany({
    where: { userId, leftAt: null, league: { kind: 'CLUB', archivedAt: null } },
    include: { league: true },
  });
  for (const member of previous) if (member.leagueId !== league?.id) await groups.leave(tx, member.league, userId);
  await tx.clubResponsibility.updateMany({
    where: { userId, ...(club ? { clubId: { not: club.id } } : {}), status: { in: ['PENDING', 'APPROVED'] } },
    data: { status: 'REVOKED', reviewedAt: new Date() },
  });
  if (league) await groups.enroll(tx, league, userId);
  const user = await tx.user.update({
    where: { id: userId },
    data: { clubId: club?.id || null, clubChoiceAt: new Date() },
  });
  if (user.favoriteLeagueId && previous.some((m) => m.leagueId === user.favoriteLeagueId && m.leagueId !== league?.id))
    await tx.user.update({ where: { id: userId }, data: { favoriteLeagueId: null } });
  return profile(tx, userId);
}
async function setClub(db, userId, input) {
  return db.$transaction((tx) => setClubInTransaction(tx, userId, input));
}
async function profile(db, userId) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { club: true, clubChoiceAt: true } });
  if (!user) throw failure('Compte introuvable.', 404);
  const responsibility = user.club
    ? await db.clubResponsibility.findUnique({ where: { clubId_userId: { clubId: user.club.id, userId } } })
    : null;
  return {
    ...user,
    responsibility: responsibility
      ? { id: responsibility.id, status: responsibility.status, reason: responsibility.reason }
      : null,
  };
}
async function directory(db, query = '') {
  const term = key(query);
  const clubs = await db.club.findMany({ orderBy: { name: 'asc' } });
  return clubs
    .filter((c) => !term || key(`${c.name} ${c.shortName} ${c.city}`).includes(term))
    .map(({ id, name, shortName, city, status, leagueId }) => ({ id, name, shortName, city, status, leagueId }));
}
async function requestRole(db, userId, reason) {
  reason = clean(reason, 5, 1000, 'Fonction et motivation');
  return db.$transaction(async (tx) => {
    await lock(tx);
    const { club } = await profile(tx, userId);
    if (!club) throw failure('Choisissez votre club avant de demander ce rôle.', 400);
    const member =
      club.leagueId &&
      (await tx.leagueMember.findUnique({ where: { leagueId_userId: { leagueId: club.leagueId, userId } } }));
    if (!member || member.leftAt) throw failure('Vous devez être membre de ce club.', 403);
    const previous = await tx.clubResponsibility.findUnique({ where: { clubId_userId: { clubId: club.id, userId } } });
    if (previous?.status === 'APPROVED') return previous;
    return tx.clubResponsibility.upsert({
      where: { clubId_userId: { clubId: club.id, userId } },
      create: { clubId: club.id, userId, reason },
      update: { reason, status: 'PENDING', reviewedBy: null, reviewedAt: null },
    });
  });
}
async function decideRole(db, actorId, userId, clubId, status) {
  if (!positive(userId) || !positive(clubId) || !['APPROVED', 'REJECTED', 'REVOKED'].includes(status))
    throw failure('Décision invalide.', 400);
  return db.$transaction(async (tx) => {
    await lock(tx);
    const admin = await tx.user.findUnique({ where: { id: actorId }, select: { isAdmin: true } });
    if (!admin?.isAdmin) throw failure('Accès administrateur requis.', 403);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { clubId: true } });
    const club = await tx.club.findUnique({ where: { id: clubId } });
    if (status === 'APPROVED') {
      const member =
        club?.leagueId &&
        (await tx.leagueMember.findUnique({ where: { leagueId_userId: { leagueId: club.leagueId, userId } } }));
      if (user?.clubId !== clubId || !member || member.leftAt)
        throw failure('Le compte doit encore appartenir à ce club.', 409);
    }
    const previous = await tx.clubResponsibility.findUnique({ where: { clubId_userId: { clubId, userId } } });
    if (!previous && status !== 'APPROVED') throw failure('Demande introuvable.', 404);
    const row = await tx.clubResponsibility.upsert({
      where: { clubId_userId: { clubId, userId } },
      create: {
        clubId,
        userId,
        status,
        reason: 'Nomination directe par un administrateur',
        reviewedBy: actorId,
        reviewedAt: new Date(),
      },
      update: { status, reviewedBy: actorId, reviewedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'CLUB_RESPONSIBILITY',
        targetType: 'ClubResponsibility',
        targetId: row.id,
        before: previous || undefined,
        after: row,
      },
    });
    return row;
  });
}

async function updatePresentation(db, userId, description) {
  description = clean(description, 0, 2000, 'Présentation');
  return db.$transaction(async (tx) => {
    await lock(tx);
    const { club, responsibility } = await profile(tx, userId);
    if (!club || responsibility?.status !== 'APPROVED') throw failure('Rôle de responsable requis.', 403);
    const member = await tx.leagueMember.findUnique({
      where: { leagueId_userId: { leagueId: club.leagueId, userId } },
    });
    if (!member || member.leftAt) throw failure('Adhésion au club requise.', 403);
    const updated = await tx.club.update({ where: { id: club.id }, data: { description } });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: 'CLUB_PRESENTATION',
        targetType: 'Club',
        targetId: club.id,
        after: { description },
      },
    });
    return updated;
  });
}

module.exports = {
  updatePresentation,
  key,
  clean,
  positive,
  lock,
  profile,
  directory,
  setClub,
  setClubInTransaction,
  requestRole,
  decideRole,
};
