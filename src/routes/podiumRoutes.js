const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authMiddleware = require('../middleware/auth');

// ---------------------------------------------------------
// 4. GET : Récupérer le statut du tournoi (PLACÉ EN PREMIER pour éviter les conflits)
// ---------------------------------------------------------
router.get('/tournament-status/:tournamentId', authMiddleware, async (req, res) => {
  try {
    const tId = parseInt(req.params.tournamentId, 10);
    const tournament = await prisma.tournament.findUnique({
      where: { id: tId }
    });
    
    res.json({ isLocked: tournament ? tournament.isPodiumLocked : false });
  } catch (err) {
    console.error("Erreur statut tournoi:", err);
    res.status(500).json({ error: "Erreur lors de la récupération du statut." });
  }
});

// ---------------------------------------------------------
// 1. POST : Enregistrer un pronostic (avec blocage si fermé)
// ---------------------------------------------------------
router.post('/', authMiddleware, async (req, res) => {
  const { tournamentId, gold, silver, bronze1, bronze2 } = req.body;
  
  if (!tournamentId || !gold || !silver || !bronze1 || !bronze2) {
    return res.status(400).json({ error: "Tous les champs du podium sont requis." });
  }

  try {
    const tId = parseInt(tournamentId, 10);

    const tournament = await prisma.tournament.upsert({
      where: { id: tId },
      update: {},
      create: { 
        id: tId, 
        name: `Tournoi ${tId}` 
      }
    });

    if (tournament.isPodiumLocked) {
      return res.status(403).json({ error: "Les pronostics sont verrouillés pour cette compétition." });
    }

    const prediction = await prisma.podiumPrediction.upsert({
      where: {
        userId_tournamentId: {
          userId: req.user.userId,
          tournamentId: tId
        }
      },
      update: { gold, silver, bronze1, bronze2 },
      create: {
        userId: req.user.userId,
        tournamentId: tId,
        gold,
        silver,
        bronze1,
        bronze2
      }
    });

    res.json({ message: "Pronostic de podium enregistré avec succès !", prediction });
  } catch (error) {
    console.error("Erreur POST podium:", error);
    res.status(500).json({ error: "Erreur lors de l'enregistrement du podium." });
  }
});

// ---------------------------------------------------------
// 2. PUT : Verrouiller / Déverrouiller le tournoi (Admin)
// ---------------------------------------------------------
router.put('/:tournamentId/toggle-lock', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: "Accès non autorisé." });
    }

    const tId = parseInt(req.params.tournamentId, 10);
    const { isLocked } = req.body;

    await prisma.tournament.upsert({
      where: { id: tId },
      update: {},
      create: { id: tId, name: `Tournoi ${tId}` }
    });

    const updatedTournament = await prisma.tournament.update({
      where: { id: tId },
      data: { isPodiumLocked: isLocked }
    });

    res.json({ 
      message: `Pronostics ${isLocked ? 'verrouillés' : 'ouverts'}.`, 
      tournament: updatedTournament 
    });
  } catch (err) {
    console.error('Erreur lors du verrouillage:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la modification du verrouillage' });
  }
});

// ---------------------------------------------------------
// 3. GET : Récupérer les pronostics de tous les utilisateurs
// ---------------------------------------------------------
router.get('/all/:tournamentId', authMiddleware, async (req, res) => {
  const { tournamentId } = req.params;

  try {
    const tId = parseInt(tournamentId, 10);

    const allPredictions = await prisma.podiumPrediction.findMany({
      where: { tournamentId: tId },
      include: {
        user: {
          select: { name: true }
        }
      }
    });

    res.json(allPredictions);
  } catch (error) {
    console.error("Erreur GET all podiums:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des pronostics." });
  }
});

module.exports = router;