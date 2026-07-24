const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authMiddleware = require('../middleware/auth');

router.post('/', authMiddleware, async (req, res) => {
  const { tournamentId, gold, silver, bronze1, bronze2 } = req.body;
  
  if (!tournamentId || !gold || !silver || !bronze1 || !bronze2) {
    return res.status(400).json({ error: "Tous les champs du podium sont requis." });
  }

  try {
    const tId = parseInt(tournamentId, 10);

    // S'assurer que le tournoi existe en base
    await prisma.tournament.upsert({
      where: { id: tId },
      update: {},
      create: { 
        id: tId, 
        name: `Tournoi ${tId}` 
      }
    });

    // Enregistrer ou mettre à jour le pronostic
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

// Récupérer les pronostics de tous les utilisateurs pour un tournoi
router.get('/all/:tournamentId', authMiddleware, async (req, res) => {
  const { tournamentId } = req.params;

  try {
    const tId = parseInt(tournamentId, 10);

    const allPredictions = await prisma.podiumPrediction.findMany({
      where: { tournamentId: tId },
      include: {
        user: {
          select: { username: true } // On récupère juste le nom d'utilisateur pour l'anonymat/affichage
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