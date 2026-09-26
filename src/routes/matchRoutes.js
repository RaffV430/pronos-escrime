const express = require('express');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { syncMatchesFromSheet } = require('../services/sheetSync'); 

const router = express.Router();
const prisma = require('../lib/prisma');
const { matchClosed, closesAt } = require('../lib/matchLock');

// 1. Liste de tous les matchs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { competitionId } = req.query;
    const filter = competitionId ? { competitionId: parseInt(competitionId, 10) } : {};

    const matches = await prisma.match.findMany({
      where: filter,
      include: { competition: { select: { name: true } }, predictions: { where: { userId: req.user.userId } } },
      orderBy: { id: 'asc' },
    });
    res.json(matches.map(match => ({ ...match, maxScore: /par équipes/i.test(match.competition?.name || '') ? 45 : 15, isClosed: matchClosed(match), closesAt: closesAt(match), winnerName: match.winner === 1 ? match.player1 : match.winner === 2 ? match.player2 : null })));
  } catch (error) {
    console.error('Erreur matches:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.' });
  }
});

// 2. Synchronisation Google Sheet
router.post('/sync-sheet', authMiddleware, adminMiddleware, async (req, res) => {
  const { competitionId } = req.body;
  if (!competitionId) {
    return res.status(400).json({ error: 'Veuillez sélectionner une compétition pour synchroniser.' });
  }

  try {
    const result = await syncMatchesFromSheet(competitionId);
    res.json({ message: 'Synchronisation terminée !', details: result });
  } catch (error) {
    console.error('Erreur synchro Sheet:', error);
    res.status(500).json({ error: error.message || 'Échec de la synchronisation' });
  }
});

// 3. Classement général TOTAL (Avec filtres optionnels : competitionId ou tournamentId)
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const { competitionId, tournamentId } = req.query;

    const users = await prisma.user.findMany({
      select: { id: true, name: true }
    });

    // Filtres dynamiques pour Prisma
    const podiumFilter = {};
    const matchFilter = {};
    const adjustmentFilter = {};

    if (competitionId) {
      // Filtrer pour une compétition précise
      const compIdInt = parseInt(competitionId, 10);
      podiumFilter.competitionId = compIdInt;
      matchFilter.match = { competitionId: compIdInt };
      adjustmentFilter.competitionId = compIdInt;
    } else if (tournamentId) {
      // Filtrer pour tout un tournoi
      const tourIdInt = parseInt(tournamentId, 10);
      podiumFilter.competition = { tournamentId: tourIdInt };
      matchFilter.match = { competition: { tournamentId: tourIdInt } };
      adjustmentFilter.tournamentId = tourIdInt;
    }

    // On récupère les données filtrées
    const allPodiumPreds = await prisma.podiumPrediction.findMany({ where: podiumFilter });
    const allMatchPreds = await prisma.prediction.findMany({ where: matchFilter });
    const poolFilter = competitionId
      ? { fencer: { pool: { competitionId: parseInt(competitionId, 10) } } }
      : tournamentId ? { fencer: { pool: { competition: { tournamentId: parseInt(tournamentId, 10) } } } } : {};
    const allPoolPreds = await prisma.poolPrediction.findMany({ where: poolFilter });
    const allAdjustments = await prisma.pointAdjustment.findMany({ where: adjustmentFilter });

    const leaderboard = users.map(user => {
      let podiumPoints = 0;
      let matchPoints = 0;
      let adjustmentPoints = 0;
      const poolPoints = allPoolPreds.filter(p => p.userId === user.id).reduce((sum, p) => sum + p.pointsEarned, 0);

      allPodiumPreds.filter(p => p.userId === user.id).forEach(p => {
        podiumPoints += (p.pointsEarned || 0);
      });

      allAdjustments.filter(a => a.userId === user.id).forEach(a => {
        adjustmentPoints += (a.points || 0);
      });

      allMatchPreds.filter(p => p.userId === user.id).forEach(p => {
        matchPoints += p.pointsEarned || 0;
      });

      return {
        id: user.id,
        name: user.name,
        matchPoints,
        podiumPoints,
        adjustmentPoints,
        poolPoints,
        totalPoints: matchPoints + podiumPoints + adjustmentPoints + poolPoints 
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints); 

    res.json(leaderboard);
  } catch (error) {
    console.error('Erreur leaderboard global:', error);
    res.status(500).json({ error: 'Erreur lors du calcul du classement général.' });
  }
});

// 4. POST : Ajouter ou modifier un pronostic
router.post('/:id/predict', authMiddleware, async (req, res) => {
  const matchId = parseInt(req.params.id); 
  const userId = req.user.userId;
  const predictedScore1 = Number(req.body.predictedScore1);
  const predictedScore2 = Number(req.body.predictedScore2);

  if (!Number.isInteger(matchId) || !Number.isInteger(predictedScore1) || !Number.isInteger(predictedScore2)
      || predictedScore1 < 0 || predictedScore2 < 0 || predictedScore1 > 999 || predictedScore2 > 999) {
    return res.status(400).json({ error: 'Les deux scores doivent être des entiers valides.' });
  }

  try {
    const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) return { status: 404, body: { error: 'Match introuvable.' } };
    if (matchClosed(match)) return { status: 409, body: { error: 'Les pronostics sont clos ou la vérification du match est en attente.' } };

    const prediction = await tx.prediction.upsert({
      where: { userId_matchId: { userId: userId, matchId: matchId } },
      update: { predictedScore1, predictedScore2 },
      create: { userId: userId, matchId: matchId, predictedScore1, predictedScore2 },
    });
    return { status: 200, body: prediction };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la sauvegarde du pronostic' });
  }
});

// 5. DELETE : Supprimer un pronostic
router.delete('/:id/predict', authMiddleware, async (req, res) => {
  const matchId = parseInt(req.params.id);
  const userId = req.user.userId;

  try {
    const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) return { status: 404, body: { error: 'Match introuvable.' } };
    if (matchClosed(match)) return { status: 409, body: { error: 'Les pronostics sont clos ou la vérification du match est en attente.' } };

    await tx.prediction.deleteMany({
      where: { userId: userId, matchId: matchId },
    });
    return { status: 200, body: { success: true, message: 'Pronostic supprimé avec succès' } };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression du pronostic' });
  }
});

// Manual reopening overrides the deadline until an administrator locks again.
router.put('/:id/lock', authMiddleware, adminMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || typeof req.body.isLocked !== 'boolean') return res.status(400).json({ error: 'Verrouillage invalide.' });
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${id} FOR UPDATE`;
      const match = await tx.match.findUnique({ where: { id } });
      if (!match) return { status: 404, error: 'Match introuvable.' };
      if (match.isFinished) return { status: 409, error: 'Un match terminé ne peut pas être rouvert.' };
      return { match: await tx.match.update({ where: { id }, data: { isLocked: req.body.isLocked, manualUnlock: !req.body.isLocked } }) };
    });
    res.status(result.status || 200).json(result);
  } catch { res.status(500).json({ error: 'Impossible de modifier le verrouillage.' }); }
});

router.put('/:id/medical-withdrawal', authMiddleware, adminMiddleware, async (req, res) => {
  const id = Number(req.params.id), winner = req.body.winner;
  if (!Number.isInteger(id) || id <= 0 || ![1, 2].includes(winner)) return res.status(400).json({ error: 'Choisissez le tireur qualifié (1 ou 2).' });
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${id} FOR UPDATE`;
      const current = await tx.match.findUnique({ where: { id } });
      if (!current) return { status: 404, error: 'Match introuvable.' };
      const match = await tx.match.update({ where: { id }, data: { winner, resultType: 'MEDICAL_WITHDRAWAL', score1: null, score2: null, isFinished: true, isLocked: true, manualUnlock: false } });
      const predictions = await tx.prediction.findMany({ where: { matchId: id } });
      const { calculateMatchPoints } = require('../services/matchPoints');
      for (const p of predictions) await tx.prediction.update({ where: { id: p.id }, data: { pointsEarned: calculateMatchPoints(p.predictedScore1, p.predictedScore2, null, null, winner, 'MEDICAL_WITHDRAWAL') } });
      return { match };
    });
    res.status(result.status || 200).json(result);
  } catch { res.status(500).json({ error: 'Impossible de valider le retrait médical.' }); }
});

module.exports = router;
