const { resolve } = require('./fencerFollows');
function matchedNames(favorites, competition) {
  return resolve(favorites, competition).matchNames;
}
function concerned(match, names) {
  return names.includes(match.player1) || names.includes(match.player2);
}
async function namesFor(db, sub, competition) {
  const favorites = await db.followedFencer.findMany({ where: { userId: sub.userId } });
  return matchedNames(favorites, competition);
}
async function queueEnrollments(tx, sub, context) {
  const preferences = require('./playerExperience').preferences(sub.preferences || {});
  if (!preferences.fencerEntries || require('./playerExperience').isQuiet(preferences)) return;
  const favorites = await tx.followedFencer.findMany({ where: { userId: sub.userId } });
  if (!favorites.length) return;
  for (const { competition: c } of context) {
    if (c.podiumResolvedAt) continue;
    const resolved = resolve(favorites, c);
    if (!resolved.links.length) continue;
    const start = await require('./eventStart').eventStartFor(tx, c.id);
    if (!(start > Date.now())) continue;
    const existing = await tx.pushDelivery.findMany({
      where: { subscriptionId: sub.id, competitionId: c.id, kind: 'FENCER_ENTRY' },
      select: { round: true },
    });
    const known = new Set(
      existing.flatMap((d) =>
        String(d.round)
          .replace(/^fencers?-/, '')
          .split('-')
          .map(Number),
      ),
    );
    const ids = resolved.links
      .map((l) => l.favoriteId)
      .filter((id) => !known.has(id))
      .sort((a, b) => a - b);
    if (!ids.length) continue;
    const round = `fencers-${ids.join('-')}`;
    const key = { subscriptionId: sub.id, competitionId: c.id, throughEventId: 0, kind: 'FENCER_ENTRY', round };
    await tx.pushDelivery.upsert({
      where: { subscriptionId_competitionId_throughEventId_kind_round: key },
      create: { ...key, matchIds: [] },
      update: {},
    });
  }
}
module.exports = { matchedNames, concerned, namesFor, queueEnrollments };
