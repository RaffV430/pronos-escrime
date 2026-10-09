const { failure } = require('./ftlClient');
const clubs = require('./accountClubs');
const DEFAULT_RULES =
  'Utilisez le nom réel de votre club d’escrime et sa ville. Les noms injurieux, discriminatoires, menaçants, à caractère sexuel, publicitaires ou usurpant une identité sont refusés. Chaque ajout doit être validé par un administrateur. En attendant, vous restez sans club / accompagnant. Vous pouvez demander un réexamen auprès de l’éditeur.';
const normalize = (s) =>
  clubs.key(
    String(s || '')
      .replace(/œ/g, 'oe')
      .replace(/æ/g, 'ae'),
  );
function validateTerms(terms) {
  if (!Array.isArray(terms) || terms.length > 2000) throw failure('Liste limitée à 2 000 mots ou expressions.', 400);
  const cleaned = terms.map((t) => normalize(clubs.clean(t, 2, 100, 'Mot ou expression')));
  if (cleaned.some((t) => t.length < 2)) throw failure('Mot ou expression invalide.', 400);
  return [...new Set(cleaned)];
}
function prohibited(input, terms) {
  return [input.name, input.city, input.shortName].some((value) => {
    const text = ` ${normalize(value)} `;
    return terms.some((term) => text.includes(` ${term} `));
  });
}
async function policy(db) {
  return (
    (await db.clubNamePolicy.findUnique({ where: { id: 1 } })) || {
      id: 1,
      revision: 0,
      terms: [],
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
  const rejected = prohibited(data, p.terms);
  const row = await tx.clubRegistrationRequest.create({
    data: {
      ...data,
      ...(rejected
        ? {
            status: 'REJECTED',
            reason:
              'Le nom, la ville ou l’abréviation ne respecte pas les règles de nommage publiées. Vous pouvez demander un réexamen auprès de l’éditeur.',
            reviewedAt: new Date(),
            mailStatus: 'PENDING',
            mailNextAt: new Date(),
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
      after: { status: row.status, policyRevision: p.revision },
    },
  });
  return row;
}
async function updatePolicy(db, actorId, input) {
  const terms = validateTerms(input.terms),
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
  return db.$transaction(async (tx) => {
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
}
module.exports = { DEFAULT_RULES, normalize, validateTerms, prohibited, policy, submit, updatePolicy, decide };
