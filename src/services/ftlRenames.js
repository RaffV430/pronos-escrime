// Renommages officiels : FencingTimeLive corrige parfois l'orthographe d'un engagé après le début des
// poules (même identifiant, même nation, nouveau nom). La liste figée de l'épreuve, les poules et les
// rencontres suivent alors le nouveau nom ; les pronostics restent liés aux identifiants et ne bougent pas.
const { parseRoster } = require('./ftlConfiguration');
const { norm } = require('./ftlParser');
const { failure } = require('./ftlClient');

function plannedRenames(current, observed) {
  const byId = new Map(observed.map((e) => [e.id, e]));
  const renames = [];
  for (const e of current || []) {
    const o = byId.get(e.id);
    if (!o || o.country !== e.country || norm(o.name) === norm(e.name)) continue;
    // Le nouveau nom ne doit désigner personne d'autre dans la liste.
    if ((current || []).some((x) => x.id !== e.id && norm(x.name) === norm(o.name))) continue;
    renames.push({ id: e.id, from: e.name, to: o.name });
  }
  return renames;
}

async function reconcileRenames(db, c, eventId, client, actorId = 0) {
  if (!c.podiumRoster || !/^[a-f0-9]{32}$/i.test(eventId || '')) return { c, renames: [] };
  const observed = parseRoster(await client.get(`/events/competitors/data/${eventId}`));
  const renames = plannedRenames(c.podiumRoster, observed);
  if (!renames.length) return { c, renames };
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    const fresh = await tx.competition.findUnique({ where: { id: c.id } });
    if (JSON.stringify(fresh.podiumRoster) !== JSON.stringify(c.podiumRoster))
      throw failure('Liste des engagés modifiée pendant le contrôle.', 409);
    const to = new Map(renames.map((r) => [r.id, r.to]));
    const roster = fresh.podiumRoster
      .map((e) => (to.has(e.id) ? { ...e, name: to.get(e.id) } : e))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    for (const r of renames) {
      await tx.poolFencer.updateMany({
        where: { name: r.from, pool: { competitionId: c.id } },
        data: { name: r.to },
      });
      await tx.match.updateMany({ where: { competitionId: c.id, player1: r.from }, data: { player1: r.to } });
      await tx.match.updateMany({ where: { competitionId: c.id, player2: r.from }, data: { player2: r.to } });
    }
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Renommage officiel d’engagés',
        targetType: 'Competition',
        targetId: c.id,
        before: { names: renames.map((r) => ({ id: r.id, name: r.from })) },
        after: { names: renames.map((r) => ({ id: r.id, name: r.to })) },
      },
    });
    return tx.competition.update({ where: { id: c.id }, data: { podiumRoster: roster, rosterCheckedAt: new Date() } });
  });
  return { c: updated, renames };
}

module.exports = { reconcileRenames, plannedRenames };
