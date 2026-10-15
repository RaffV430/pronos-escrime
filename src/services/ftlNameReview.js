// Correspondances explicites limitées à une épreuve ; aucun renommage ni changement de pronostic.
const { failure } = require('./ftlClient');
const { stamp } = require('./identityReview');
const { norm } = require('./ftlParser');
const key = (id) => `ftl-name-review:${id}`;
const clean = (s) =>
  String(s || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ');
const unknownNames = (warnings) => [
  ...new Set(
    (warnings || []).flatMap((w) => {
      const found = /Nom officiel ambigu ou absent des engagés : (.+)\.$/.exec(w);
      return found ? [found[1]] : [];
    }),
  ),
];
async function aliases(db, competitionId) {
  if (!db.appSetting) return [];
  const row = await db.appSetting.findUnique({ where: { key: key(competitionId) } });
  return Array.isArray(row?.value) ? row.value : [];
}
async function review(db, competitionId) {
  const c = await db.competition.findUnique({ where: { id: competitionId } });
  if (!c) throw failure('Épreuve introuvable.', 404);
  const last = await db.auditLog.findFirst({
    where: { action: 'Contrôle FTL terminé', targetType: 'Competition', targetId: competitionId },
    orderBy: { id: 'desc' },
  });
  const warnings = last?.after?.warnings || [];
  const entries = (c.podiumRoster || []).filter((e) => e.active !== false);
  const saved = await aliases(db, competitionId);
  return {
    competitionId,
    name: c.name,
    sourceUrl: c.rosterSourceUrl,
    entries: entries.map(({ id, name, country }) => ({ id, name, country })),
    unknownNames: unknownNames(warnings),
    aliases: saved,
    version: stamp([c.podiumRoster, c.ftlEventId, c.rosterSourceUrl, unknownNames(warnings), saved]),
  };
}
async function confirm(db, competitionId, input, actorId) {
  if (input?.confirm !== true) throw failure('Confirmez qu’il s’agit du même tireur.', 400);
  const sourceName = clean(input.sourceName),
    reason = clean(input.reason);
  if (sourceName.length < 3 || sourceName.length > 120 || reason.length < 10 || reason.length > 1000)
    throw failure('Indiquez le nom officiel et un motif de 10 à 1 000 caractères.', 400);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
    const current = await review(tx, competitionId);
    if (current.version !== input.version) throw failure('Le dossier a changé. Actualisez avant de confirmer.', 409);
    if (!current.unknownNames.includes(sourceName))
      throw failure('Ce nom ne figure plus parmi les avertissements.', 409);
    const targets = current.entries.filter((e) => e.id === input.entryId);
    if (targets.length !== 1 || current.entries.filter((e) => norm(e.name) === norm(targets[0].name)).length !== 1)
      throw failure('Engagé ambigu ou absent : confirmation impossible.', 409);
    if (current.entries.some((e) => norm(e.name) === norm(sourceName)))
      throw failure('Ce nom existe déjà parmi les engagés : une vérification supplémentaire est nécessaire.', 409);
    const entry = { sourceName, entryId: targets[0].id, entryName: targets[0].name };
    const next = current.aliases.filter((a) => norm(a.sourceName) !== norm(sourceName)).concat(entry);
    await tx.appSetting.upsert({
      where: { key: key(competitionId) },
      create: { key: key(competitionId), value: next },
      update: { value: next },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Correspondance FTL confirmée',
        targetType: 'Competition',
        targetId: competitionId,
        before: { aliases: current.aliases },
        after: { ...entry, reason },
      },
    });
    return { success: true };
  });
}
async function remove(db, competitionId, input, actorId) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
    const current = await review(tx, competitionId);
    if (current.version !== input?.version) throw failure('Le dossier a changé. Actualisez.', 409);
    const next = current.aliases.filter((a) => a.sourceName !== input.sourceName);
    if (next.length === current.aliases.length) throw failure('Correspondance introuvable.', 404);
    await tx.appSetting.update({ where: { key: key(competitionId) }, data: { value: next } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Correspondance FTL retirée',
        targetType: 'Competition',
        targetId: competitionId,
        before: { aliases: current.aliases },
        after: { aliases: next },
      },
    });
    return { success: true };
  });
}
module.exports = { aliases, review, confirm, remove, unknownNames };
