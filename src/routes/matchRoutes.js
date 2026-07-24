const express = require('express');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../middleware/auth');

// 1. Import de notre service Google Sheet
const { syncMatchesFromSheet } = require('../services/sheetSync'); 

const router = express.Router();
const prisma = new PrismaClient();

// 1. Liste de tous les matchs
router.get('/', async (req, res) => {
  try {
    const matches = await prisma.match.findMany({
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
  try {
    const result = await syncMatchesFromSheet();
    res.json({ message: 'Synchronisation terminée !', details: result });
  } catch (error) {
    console.error('Erreur synchro Sheet:', error);
    res.status(500).json({ error: 'Échec de la synchronisation' });
  }
});

// 3. Classement général des utilisateurs
router.get('/leaderboard', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, totalPoints: true },
      orderBy: { totalPoints: 'desc' },
      take: 20,
    });
    res.json(users);
  } catch (error) {
    console.error('Erreur leaderboard:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du classement.' });
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
      where: {
        userId_matchId: {
          userId: userId,
          matchId: matchId,
        },
      },
      update: {
        predictedScore1,
        predictedScore2,
      },
      create: {
        userId: userId,
        matchId: matchId,
        predictedScore1,
        predictedScore2,
      },
    });

    res.json(prediction);
  } catch (error) {
    console.error('Erreur pronostic:', error);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde du pronostic' });
  }
});

// 5. DELETE : Supprimer un pronostic (BIEN PLACÉ EN DEHORS DE LA ROUTE PRÉCÉDENTE)
router.delete('/:id/predict', authMiddleware, async (req, res) => {
  const matchId = parseInt(req.params.id);
  const userId = req.user.userId;

  try {
    await prisma.prediction.deleteMany({
      where: {
        userId: userId,
        matchId: matchId,
      },
    });

    res.json({ success: true, message: 'Pronostic supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression pronostic:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du pronostic' });
  }
});

module.exports = router;