// Outils d'administration pour les écarts mis de côté pendant une épreuve (le déroulé n'est jamais bloqué,
// les incohérences sont traitées ensuite) : inscriptions en double, matchs de tableau à vérifier.
const { failure } = require('./ftlClient');
const { norm } = require('./ftlParser');

const CANCELLED_ACTION = 'Affiche annulée après remaniement officiel';
const positiveId = (value, label = 'Identifiant invalide.') => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw failure(label, 400);
  return n;
};
const predictedWinner = (p) =>
  p.predictedScore1 > p.predictedScore2 ? 1 : p.predictedScore2 > p.predictedScore1 ? 2 : 0;

// engarde-service : chaque engagé a son propre numéro de série et son club, lus avec le nom. Même nom,
// clubs tous connus et différents : homonymes (deux tireurs présents), poules et matchs départagés par le
// club. Ce n'est pas une inscription en double, rien à trancher.
const homonyms = (group) => {
  const clubs = group.map((e) => norm(e.country || ''));
  return clubs.every(Boolean) && new Set(clubs).size === clubs.length;
};

// Inscriptions portant le même nom dans la liste des engagés d'une épreuve.
async function duplicates(db, competitionId) {
  const c = await db.competition.findUnique({
    where: { id: positiveId(competitionId, 'Épreuve invalide.') },
    select: { id: true, name: true, podiumRoster: true, rosterSourceUrl: true, resultsSourceUrl: true },
  });
  if (!c) throw failure('Épreuve introuvable.', 404);
  const engarde = /engarde-service\.com/i.test(`${c.rosterSourceUrl || ''} ${c.resultsSourceUrl || ''}`);
  const groups = new Map();
  for (const e of c.podiumRoster || []) {
    const k = norm(e.name);
    groups.set(k, [...(groups.get(k) || []), e]);
  }
  return {
    competition: { id: c.id, name: c.name },
    duplicates: [...groups.values()]
      .filter((g) => g.length > 1 && !(engarde && homonyms(g)))
      .map((g) => ({
        name: g[0].name,
        entries: g.map((e) => ({
          id: String(e.id),
          country: e.country || null,
          entryRanking: e.entryRanking ?? null,
          active: e.active !== false,
        })),
      })),
  };
}

// Retient une inscription : les autres inscriptions du même nom sont écartées (active: false).
async function keepEntry(db, competitionId, entryId, actorId) {
  const id = positiveId(competitionId, 'Épreuve invalide.');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${id} FOR UPDATE`;
    const c = await tx.competition.findUnique({ where: { id } });
    if (!c) throw failure('Épreuve introuvable.', 404);
    const roster = c.podiumRoster || [];
    const kept = roster.find((e) => String(e.id) === String(entryId));
    if (!kept) throw failure('Inscription introuvable.', 404);
    const same = roster.filter((e) => norm(e.name) === norm(kept.name));
    if (same.length < 2) throw failure('Aucune autre inscription à ce nom.', 409);
    const next = roster.map((e) =>
      norm(e.name) !== norm(kept.name) ? e : { ...e, active: String(e.id) === String(kept.id) },
    );
    await tx.competition.update({ where: { id }, data: { podiumRoster: next } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Inscription en double tranchée',
        targetType: 'Competition',
        targetId: id,
        before: { entries: same.map((e) => ({ id: e.id, active: e.active !== false })) },
        after: { kept: kept.id, name: kept.name },
      },
    });
    return {
      kept: String(kept.id),
      name: kept.name,
      discarded: same.filter((e) => e !== kept).map((e) => String(e.id)),
    };
  });
}

// Matchs de tableau mis de côté (écart avec la source, affiche annulée) en attente d'une décision.
async function matchReviews(db, competitionId = null) {
  const matches = await db.match.findMany({
    where: {
      syncIssue: { not: null },
      ...(competitionId ? { competitionId: positiveId(competitionId, 'Épreuve invalide.') } : {}),
    },
    include: {
      competition: { select: { id: true, name: true, tournamentId: true } },
      predictions: { select: { predictedScore1: true, predictedScore2: true } },
    },
    orderBy: { id: 'asc' },
  });
  const logs = matches.length
    ? await db.auditLog.findMany({
        where: { targetType: 'Match', targetId: { in: matches.map((m) => m.id) }, action: CANCELLED_ACTION },
        orderBy: { id: 'desc' },
      })
    : [];
  return matches.map((m) => {
    const log = logs.find((l) => l.targetId === m.id);
    const picks = m.predictions.map(predictedWinner);
    return {
      id: m.id,
      competition: m.competition,
      round: m.round,
      player1: m.player1,
      player2: m.player2,
      cancelled: m.resultType === 'CANCELLED',
      isFinished: m.isFinished,
      score1: m.score1,
      score2: m.score2,
      issue: m.syncIssue,
      official: log?.after?.official || null,
      predictions: {
        total: picks.length,
        player1: picks.filter((w) => w === 1).length,
        player2: picks.filter((w) => w === 2).length,
      },
    };
  });
}

async function lockedMatch(tx, matchId) {
  const id = positiveId(matchId, 'Match invalide.');
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${id} FOR UPDATE`;
  const m = await tx.match.findUnique({ where: { id } });
  if (!m) throw failure('Match introuvable.', 404);
  if (!m.syncIssue) throw failure('Ce match n’est plus en attente de vérification.', 409);
  return m;
}

// Affiche annulée : seuls les pronostics qui donnaient le bon vainqueur reçoivent le point du vainqueur
// (pas de bonus de score, l'affiche n'ayant pas eu lieu telle quelle).
async function awardWinner(db, matchId, winner, actorId) {
  if (![1, 2].includes(winner)) throw failure('Choisissez le vainqueur (1 ou 2).', 400);
  const out = await db.$transaction(async (tx) => {
    const m = await lockedMatch(tx, matchId);
    if (m.resultType !== 'CANCELLED') throw failure('Pour un match joué, corrigez le résultat officiel du match.', 409);
    const predictions = await tx.prediction.findMany({ where: { matchId: m.id } });
    let awarded = 0;
    for (const p of predictions) {
      const points = predictedWinner(p) === winner ? m.pointsMultiplier || 1 : 0;
      awarded += points;
      if (p.pointsEarned !== points || p.bonusPoints)
        await tx.prediction.update({ where: { id: p.id }, data: { pointsEarned: points, bonusPoints: 0 } });
    }
    await tx.match.update({ where: { id: m.id }, data: { winner, syncIssue: null } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Vainqueur validé sur affiche annulée',
        targetType: 'Match',
        targetId: m.id,
        before: { syncIssue: m.syncIssue },
        after: { winner, name: winner === 1 ? m.player1 : m.player2, awarded, predictions: predictions.length },
      },
    });
    return { id: m.id, awarded, predictions: predictions.length };
  });
  require('./standings').invalidateStandings();
  return out;
}

// Clôture sans points : l'affiche est annulée (si elle ne l'était pas) et ses pronostics restent à 0.
async function closeWithoutPoints(db, matchId, actorId) {
  const out = await db.$transaction(async (tx) => {
    const m = await lockedMatch(tx, matchId);
    if (m.resultType !== 'CANCELLED' && m.isFinished && !m.pointsPending)
      throw failure('Ce match a un résultat officiel : corrigez-le plutôt que de l’annuler.', 409);
    await tx.match.update({
      where: { id: m.id },
      data: {
        ...(m.resultType === 'CANCELLED'
          ? {}
          : {
              sourceKey: m.sourceKey ? `cancelled:${m.id}:${m.sourceKey}` : null,
              resultType: 'CANCELLED',
              isFinished: true,
              isLocked: true,
              manualUnlock: false,
              winner: null,
              score1: null,
              score2: null,
              pointsPending: false,
            }),
        syncIssue: null,
      },
    });
    const updated = await tx.prediction.updateMany({
      where: { matchId: m.id },
      data: { pointsEarned: 0, bonusPoints: 0 },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Match vérifié : clos sans points',
        targetType: 'Match',
        targetId: m.id,
        before: { syncIssue: m.syncIssue, resultType: m.resultType, player1: m.player1, player2: m.player2 },
        after: { resultType: 'CANCELLED', predictions: updated.count },
      },
    });
    return { id: m.id, predictions: updated.count };
  });
  require('./standings').invalidateStandings();
  return out;
}

module.exports = { duplicates, keepEntry, matchReviews, awardWinner, closeWithoutPoints, predictedWinner };
