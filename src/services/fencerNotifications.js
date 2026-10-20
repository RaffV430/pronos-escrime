const { resolve } = require('./fencerFollows');
const low = (s) =>
  String(s || '')
    .trim()
    .toLowerCase();
// Noms des tireurs suivis dans une épreuve. Homonymes : liste à part (`clubs`), reconnus par nom + club.
function matchedNames(favorites, competition) {
  const { matchNames, clubNames = [] } = resolve(favorites, competition);
  return withClubs([...matchNames], clubNames);
}
function withClubs(names, clubNames = []) {
  Object.defineProperty(names, 'clubs', { value: clubNames, enumerable: false });
  return names;
}
// Tireur suivi : nom sans homonyme, ou nom + club d'un homonyme suivi.
function isMine(names, name, club) {
  if (!names || !name) return false;
  if (names.includes(name)) return true;
  return Boolean(club && (names.clubs || []).some((x) => low(x.name) === low(name) && low(x.club) === low(club)));
}
const hasAny = (names) => Boolean(names && (names.length || names.clubs?.length));
function concerned(match, names) {
  return isMine(names, match.player1, match.club1) || isMine(names, match.player2, match.club2);
}
async function namesFor(db, sub, competition) {
  const favorites = await db.followedFencer.findMany({ where: { userId: sub.userId } });
  // Épreuve par équipes : résultats des équipes suivies dans cette épreuve.
  if (competition?.podiumFormat === 'TEAM')
    return (await require('./teamFollows').forCompetition(db, sub.userId, competition, favorites)).names;
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
module.exports = { matchedNames, concerned, namesFor, queueEnrollments, isMine, hasAny };
