const crypto = require('node:crypto');
const { mergeRoster } = require('./engardeRoster');
const { failure } = require('./ftlClient');
const stamp = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = (s) =>
  String(s || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
function conflicts(current, observed) {
  return current.flatMap((entry) => {
    const named = observed.filter((o) => norm(o.name) === norm(entry.name));
    const candidate = observed.find((o) => o.id === entry.id) || (named.length === 1 ? named[0] : null);
    return candidate && entry.country && candidate.country && norm(entry.country) !== norm(candidate.country)
      ? [{ current: entry, observed: candidate }]
      : [];
  });
}
async function record(db, competition, sourceUrl, observed) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competition.id} FOR UPDATE`;
    const fresh = await tx.competition.findUnique({ where: { id: competition.id } });
    if (!fresh || stamp(fresh.podiumRoster) !== stamp(competition.podiumRoster))
      throw failure('Liste modifiée pendant le contrôle. Réessayez.', 409);
    const review = {
      version: stamp([fresh.podiumRoster, sourceUrl, observed]),
      sourceUrl,
      rosterVersion: stamp(fresh.podiumRoster),
      sourceVersion: stamp([fresh.rosterSourceUrl, fresh.ftlEventId]),
      observed,
      conflicts: conflicts(fresh.podiumRoster || [], observed),
    };
    if (fresh.identityReview?.version === review.version) return;
    await tx.competition.update({ where: { id: fresh.id }, data: { identityReview: review } });
  });
}
async function confirm(db, competitionId, version, reason, actorId) {
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000)
    throw failure('Indiquez un motif de 10 à 1 000 caractères.', 400);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
    const c = await tx.competition.findUnique({ where: { id: competitionId } });
    const review = c?.identityReview;
    if (
      !review ||
      review.version !== version ||
      review.rosterVersion !== stamp(c.podiumRoster) ||
      review.sourceVersion !== stamp([c.rosterSourceUrl, c.ftlEventId])
    )
      throw failure('Le conflit a changé. Actualisez avant de confirmer.', 409);
    const pairs = conflicts(c.podiumRoster || [], review.observed);
    if (!pairs.length || pairs.length !== review.conflicts.length)
      throw failure('Identités ambiguës : confirmation impossible.', 409);
    // Explicit administrator confirmation changes metadata only. IDs and prediction rows are untouched.
    const corrected = c.podiumRoster.map((e) => {
      const pair = pairs.find((p) => p.current.id === e.id);
      return pair ? { ...e, country: pair.observed.country } : e;
    });
    const { merged, renames } = mergeRoster(corrected, review.observed);
    if (renames.length) throw failure('Un renommage supplémentaire exige un nouveau contrôle officiel.', 409);
    await tx.competition.update({
      where: { id: c.id },
      data: { podiumRoster: merged, identityReview: require('@prisma/client').Prisma.DbNull },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Identités officielles confirmées',
        targetType: 'Competition',
        targetId: c.id,
        before: { roster: c.podiumRoster },
        after: { roster: merged, sourceUrl: review.sourceUrl, reason: reason.trim() },
      },
    });
    return { success: true };
  });
}
module.exports = { conflicts, stamp, record, confirm };
