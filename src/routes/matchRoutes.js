const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/auth');
const { syncMatchesFromSheet } = require('../services/sheetSync'); 

const router = express.Router();
const prisma = new PrismaClient();

// 1. Liste de tous les matchs
router.get('/', async (req, res) => {
  try {
    const { competitionId } = req.query;
    const filter = competitionId ? { competitionId: parseInt(competitionId, 10) } : {};

    const matches = await prisma.match.findMany({
      where: filter,
      include: { predictions: true },
      orderBy: { id: 'asc' },
    });
    res.json(matches);
  } catch (error) {
    console.error('Erreur matches:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.' });
  }
});

// 2. Synchronisation Google Sheet
router.post('/sync-sheet', async (req, res) => {
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

// 3. Classement général TOTAL (Calculé en temps réel : Matchs + Podiums)
router.get('/leaderboard', async (req, res) => {
  try {
    // On récupère tous les joueurs
    const users = await prisma.user.findMany({
      select: { id: true, name: true }
    });

    // On récupère TOUS les pronostics de l'application
    const allPodiumPreds = await prisma.podiumPrediction.findMany();
    const allMatchPreds = await prisma.prediction.findMany({
      include: { match: true }
    });

    const leaderboard = users.map(user => {
      let podiumPoints = 0;
      let matchPoints = 0;

      // Addition des points de Podiums (déjà calculés par la validation Admin)
      allPodiumPreds.filter(p => p.userId === user.id).forEach(p => {
        podiumPoints += (p.pointsEarned || 0);
      });

      // Calcul direct des points de Matchs selon le barème officiel
      allMatchPreds.filter(p => p.userId === user.id).forEach(p => {
        const match = p.match;
        if (match && match.isFinished) {
          // Déterminer le vainqueur réel (1 pour Tireur1, 2 pour Tireur2, 0 pour égalité/erreur)
          const actualWinner = match.score1 > match.score2 ? 1 : (match.score2 > match.score1 ? 2 : 0);
          // Déterminer le vainqueur pronostiqué
          const predWinner = p.predictedScore1 > p.predictedScore2 ? 1 : (p.predictedScore2 > p.predictedScore1 ? 2 : 0);
          
          if (actualWinner !== 0 && actualWinner === predWinner) {
            matchPoints += 1; // Le vainqueur est bon = 1 point
            
            // Vérification du bonus de score exact (+3 points)
            if (p.predictedScore1 === match.score1 && p.predictedScore2 === match.score2) {
              matchPoints += 3; 
            }
          }
        }
      });

      return {
        id: user.id,
        name: user.name,
        matchPoints,
        podiumPoints,
        totalPoints: matchPoints + podiumPoints // Le vrai Total Absolu
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints); // Tri du premier au dernier

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
  const { predictedScore1, predictedScore2 } = req.body;

  if (predictedScore1 === undefined || predictedScore2 === undefined) {
    return res.status(400).json({ error: 'Veuillez renseigner les deux scores.' });
  }

  try {
    const prediction = await prisma.prediction.upsert({
      where: { userId_matchId: { userId: userId, matchId: matchId } },
      update: { predictedScore1, predictedScore2 },
      create: { userId: userId, matchId: matchId, predictedScore1, predictedScore2 },
    });
    res.json(prediction);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la sauvegarde du pronostic' });
  }
});

// 5. DELETE : Supprimer un pronostic
router.delete('/:id/predict', authMiddleware, async (req, res) => {
  const matchId = parseInt(req.params.id);
  const userId = req.user.userId;

  try {
    await prisma.prediction.deleteMany({
      where: { userId: userId, matchId: matchId },
    });
    res.json({ success: true, message: 'Pronostic supprimé avec succès' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression du pronostic' });
  }
});

module.exports = router;