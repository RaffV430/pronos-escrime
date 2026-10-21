// Onglet « Podium » des Classements : pour chaque épreuve, rangée dans son tournoi, le podium officiel et le
// podium pronostiqué par chaque joueur avec ses points. Les pronostics des autres ne sont visibles qu'une fois
// les pronostics de podium clos (personne ne peut recopier) ; avant, seulement le sien et le nombre de joueurs.
const { podiumClosed } = require('../lib/matchLock');
const { fields, roster, verifiedPodium, predictionIds } = require('./podiumRules');

const SLOT_PLACE = { gold: 1, silver: 2, bronze1: 3, bronze2: 3 };

function officialOf(competition) {
  try {
    return verifiedPodium(competition);
  } catch {
    return null; // résultats officiels pas encore définitifs
  }
}

// Choix d'un joueur : nom par médaille et justesse (« exact » à la bonne place, « podium » ailleurs sur le podium).
function picksOf(competition, prediction, official) {
  let ids = null;
  try {
    ids = predictionIds(competition, prediction);
  } catch {
    ids = null; // ancien pronostic ambigu : noms seuls
  }
  const medalists = official ? fields(competition.podiumFormat).map((k) => official[k]) : [];
  return fields(competition.podiumFormat).map((slot) => {
    const id = ids?.[slot];
    const place = official && id ? SLOT_PLACE[Object.keys(official).find((k) => official[k] === id)] : undefined;
    return {
      slot,
      name: prediction[slot],
      status:
        !official || !id ? null : place === SLOT_PLACE[slot] ? 'exact' : medalists.includes(id) ? 'podium' : 'miss',
    };
  });
}

async function podiumOverview(db, userId, { tournamentId = null, isAdmin = false } = {}) {
  const tournaments = await db.tournament.findMany({
    where: tournamentId ? { id: tournamentId } : {},
    select: { id: true, name: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!tournaments.length) return [];
  const competitions = await db.competition.findMany({
    where: { tournamentId: { in: tournaments.map((t) => t.id) }, podiumFormat: { in: ['INDIVIDUAL', 'TEAM'] } },
    orderBy: { id: 'asc' },
  });
  const ids = competitions.map((c) => c.id);
  const [predictions, matches] = await Promise.all([
    db.podiumPrediction.findMany({
      where: { competitionId: { in: ids } },
      include: { user: { select: { id: true, name: true } } },
    }),
    db.match.findMany({ where: { competitionId: { in: ids } } }),
  ]);
  const byTournament = new Map(tournaments.map((t) => [t.id, { ...t, competitions: [] }]));
  for (const c of competitions) {
    const own = predictions.filter((p) => p.competitionId === c.id);
    if (!own.length) continue;
    let names = null;
    try {
      names = new Map(roster(c).map((e) => [e.id, e.name]));
    } catch {
      continue; // liste des engagés non configurée
    }
    const closed = podiumClosed(
      c,
      matches.filter((m) => m.competitionId === c.id),
    );
    const official = closed ? officialOf(c) : null;
    const visible = closed || isAdmin ? own : own.filter((p) => p.userId === userId);
    byTournament.get(c.tournamentId)?.competitions.push({
      id: c.id,
      name: c.name,
      format: c.podiumFormat,
      closed,
      official: official
        ? fields(c.podiumFormat).map((slot) => ({ slot, name: names.get(official[slot]) || null }))
        : null,
      players: own.length,
      predictions: visible
        .map((p) => ({
          userId: p.userId,
          name: p.user?.name || 'Joueur',
          isMe: p.userId === userId,
          points: official || c.podiumResolvedAt ? p.pointsEarned || 0 : null,
          picks: picksOf(c, p, official),
        }))
        .sort((a, b) => (b.points ?? -1) - (a.points ?? -1) || a.name.localeCompare(b.name, 'fr')),
    });
  }
  return [...byTournament.values()].filter((t) => t.competitions.length);
}

module.exports = { podiumOverview, picksOf };
