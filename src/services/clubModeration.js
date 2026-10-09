const { failure } = require('./ftlClient');
const clubs = require('./accountClubs');
const DEFAULT_RULES =
  'Utilisez le nom réel de votre club d’escrime et sa ville. Les noms injurieux, discriminatoires, menaçants, à caractère sexuel, publicitaires ou usurpant une identité sont refusés. Chaque ajout doit être validé par un administrateur. En attendant, vous restez sans club / accompagnant. Vous pouvez demander un réexamen auprès de l’éditeur.';
const screening = require('./clubNameScreening');
const { normalize, validateTerms } = screening;
const defaultTerms = validateTerms(require('../data/club-name-moderation.json'));
const prohibited = (input, terms) => Boolean(screening.screen(input, terms).blocked);
async function policy(db) {
  return (
    (await db.clubNamePolicy.findUnique({ where: { id: 1 } })) || {
      id: 1,
      revision: 0,
      terms: defaultTerms,
      rules: DEFAULT_RULES,
    }
  );
}
async function submit(tx, userId, input) {
  const data = {
    userId,
    name: clubs.clean(input.name, 2, 120, 'Nom du club'),
    city: clubs.clean(input.city, 2, 100, 'Ville'),
    shortName: clubs.clean(input.shortName || '', 0, 40, 'Abréviation'),
  };
  const p = await policy(tx);
  const result = screening.screen(data, p.terms);
  const rejected = Boolean(result.blocked);
  const row = await tx.clubRegistrationRequest.create({
    data: {
      ...data,
      ...(rejected
        ? {
            status: 'REJECTED',
            reason: screening.refusalReason(result.blocked),
            reviewedAt: new Date(),
            mailStatus: 'PENDING',
            mailNextAt: new Date(),
          }
        : result.review.length
          ? {
              reason: `Vérification requise : ${result.review
                .map(
                  (m) =>
                    `${m.kind === 'similar' ? 'ressemblance avec' : 'terme à revoir'} « ${m.terme} » (${m.categorie})`,
                )
                .slice(0, 8)
                .join('; ')}`,
            }
          : {}),
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: userId,
      action: rejected ? 'CLUB_REQUEST_AUTO_REJECT' : 'CLUB_REQUEST',
      targetType: 'ClubRegistrationRequest',
      targetId: row.id,
      after: { status: row.status, policyRevision: p.revision, screening: result.matches },
    },
  });
  return row;
}
async function updatePolicy(db, actorId, input) {
  const terms = input.csv !== undefined ? screening.parseCsv(input.csv) : validateTerms(input.terms),
    rules = clubs.clean(input.rules, 20, 5000, 'Règles');
  if (!Number.isSafeInteger(input.revision)) throw failure('Version des règles requise.', 400);
  return db.$transaction(async (tx) => {
    await clubs.lock(tx);
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { isAdmin: true } });
    if (!actor?.isAdmin) throw failure('Accès administrateur requis.', 403);
    const current = await policy(tx);
    if (current.revision !== input.revision) throw failure('Les règles ont changé. Rechargez avant de modifier.', 409);
    const next = await tx.clubNamePolicy.upsert({
      where: { id: 1 },
      create: { id: 1, revision: 1, terms, rules },
      update: { revision: { increment: 1 }, terms, rules },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'CLUB_NAME_POLICY',
        targetType: 'ClubNamePolicy',
        targetId: 1,
        before: current,
        after: next,
      },
    });
    return next;
  });
}
async function decide(db, actorId, id, input) {
  if (!clubs.positive(id) || !['APPROVED', 'REJECTED'].includes(input.status)) throw failure('Décision invalide.', 400);
  const result = await db.$transaction(async (tx) => {
    await clubs.lock(tx);
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { isAdmin: true } });
    if (!actor?.isAdmin) throw failure('Accès administrateur requis.', 403);
    const row = await tx.clubRegistrationRequest.findUnique({ where: { id } });
    if (!row) throw failure('Demande introuvable.', 404);
    if (row.status === input.status) return row;
    if (row.status !== 'PENDING') throw failure('Cette demande n’est plus en attente.', 409);
    let clubId = null;
    if (input.status === 'APPROVED') {
      const p = await policy(tx);
      if (prohibited(row, p.terms))
        throw failure('Cette demande contient un terme interdit. Modifiez les règles ou refusez avec un motif.', 409);
      const club = await clubs.findOrCreate(tx, clubs.positive(input.clubId) ? { clubId: input.clubId } : row);
      await tx.club.update({ where: { id: club.id }, data: { status: 'VERIFIED' } });
      clubId = club.id;
      await clubs.setClubInTransaction(tx, row.userId, { clubId });
    }
    const reason = input.status === 'REJECTED' ? clubs.clean(input.reason, 5, 1000, 'Motif du refus') : '';
    const updated = await tx.clubRegistrationRequest.update({
      where: { id },
      data: {
        status: input.status,
        reason,
        clubId,
        reviewedBy: actorId,
        reviewedAt: new Date(),
        ...(input.status === 'REJECTED' ? { mailStatus: 'PENDING', mailNextAt: new Date() } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'CLUB_REQUEST_DECISION',
        targetType: 'ClubRegistrationRequest',
        targetId: id,
        before: row,
        after: updated,
      },
    });
    return updated;
  });
  require('./clubRequestMail').wake(db);
  return result;
}
async function listRequests(db) {
  const include = { user: { select: { id: true, name: true } } };
  return db.$transaction(async (tx) => {
    const pending = await tx.clubRegistrationRequest.findMany({
      where: { status: 'PENDING' },
      include,
      orderBy: { id: 'desc' },
    });
    const recent = await tx.clubRegistrationRequest.findMany({
      where: { status: { not: 'PENDING' } },
      include,
      orderBy: { id: 'desc' },
      take: 200,
    });
    return [...pending, ...recent];
  });
}
module.exports = {
  listRequests,
  DEFAULT_RULES,
  normalize,
  validateTerms,
  prohibited,
  policy,
  submit,
  updatePolicy,
  decide,
};
