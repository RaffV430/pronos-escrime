const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const authMiddleware = require('../middleware/auth');

// ---------------------------------------------------------
// 0. GET : Récupérer toutes les compétitions d'un tournoi
// ---------------------------------------------------------
router.get('/competitions/:tournamentId', authMiddleware, async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.tournamentId, 10);
    const competitions = await prisma.competition.findMany({
      where: { tournamentId },
      orderBy: { id: 'asc' }
    });
    res.json(competitions);
  } catch (err) {
    console.error("Erreur récupération compétitions:", err);
    res.status(500).json({ error: "Erreur lors de la récupération des compétitions." });
  }
});

// ---------------------------------------------------------
// 4. GET : Récupérer le statut d'une compétition spécifique
// ---------------------------------------------------------
router.get('/competition-status/:competitionId', authMiddleware, async (req, res) => {
  try {
    const compId = parseInt(req.params.competitionId, 10);
    const competition = await prisma.competition.findUnique({
      where: { id: compId }
    });
    
    res.json({ isLocked: competition ? competition.isPodiumLocked : false });
  } catch (err) {
    console.error("Erreur statut compétition:", err);
    res.status(500).json({ error: "Erreur lors de la récupération du statut." });
  }
});

// ---------------------------------------------------------
// 1. GET : Récupérer son propre pronostic pour une compétition
// ---------------------------------------------------------
router.get('/:competitionId', authMiddleware, async (req, res) => {
  try {
    const compId = parseInt(req.params.competitionId, 10);
    const prediction = await prisma.podiumPrediction.findUnique({
      where: {
        userId_competitionId: {
          userId: req.user.userId,
          competitionId: compId
        }
      }
    });
    res.json(prediction || {});
  } catch (err) {
    console.error("Erreur chargement podium competition", err);
    res.status(500).json({ error: "Erreur lors du chargement du podium." });
  }
});

// ---------------------------------------------------------
// 2. POST : Enregistrer un pronostic de podium (par competitionId)
// ---------------------------------------------------------
router.post('/', authMiddleware, async (req, res) => {
  const { competitionId, gold, silver, bronze1, bronze2 } = req.body;
  
  if (!competitionId || !gold || !silver || !bronze1 || !bronze2) {
    return res.status(400).json({ error: "Tous les champs du podium sont requis." });
  }

  try {
    const compId = parseInt(competitionId, 10);

    const competition = await prisma.competition.findUnique({
      where: { id: compId }
    });

    if (!competition) {
      return res.status(404).json({ error: "Compétition introuvable." });
    }

    if (competition.isPodiumLocked) {
      return res.status(403).json({ error: "Les pronostics sont verrouillés pour cette compétition." });
    }

    const prediction = await prisma.podiumPrediction.upsert({
      where: {
        userId_competitionId: {
          userId: req.user.userId,
          competitionId: compId
        }
      },
      update: { gold, silver, bronze1, bronze2 },
      create: {
        userId: req.user.userId,
        competitionId: compId,
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
// 3. PUT : Verrouiller / Déverrouiller une compétition (Admin)
// ---------------------------------------------------------
router.put('/competition/:competitionId/toggle-lock', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: "Accès non autorisé." });
    }

    const compId = parseInt(req.params.competitionId, 10);
    const { isLocked } = req.body;

    const updatedCompetition = await prisma.competition.update({
      where: { id: compId },
      data: { isPodiumLocked: isLocked }
    });

    res.json({ 
      message: `Pronostics ${isLocked ? 'verrouillés' : 'ouverts'} pour cette compétition.`, 
      competition: updatedCompetition 
    });
  } catch (err) {
    console.error('Erreur lors du verrouillage:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la modification du verrouillage' });
  }
});

// ---------------------------------------------------------
// 4. GET : Récupérer les pronostics de tous les utilisateurs pour une compétition
// ---------------------------------------------------------
router.get('/all/competition/:competitionId', authMiddleware, async (req, res) => {
  const { competitionId } = req.params;

  try {
    const compId = parseInt(competitionId, 10);

    const allPredictions = await prisma.podiumPrediction.findMany({
      where: { competitionId: compId },
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

// ---------------------------------------------------------
// 5. GET : Classement général du tournoi (somme des points de toutes les compétitions)
// ---------------------------------------------------------
router.get('/leaderboard/:tournamentId', authMiddleware, async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.tournamentId, 10);

    // 1. Récupérer toutes les compétitions du tournoi
    const competitions = await prisma.competition.findMany({
      where: { tournamentId },
      select: { id: true }
    });

    const competitionIds = competitions.map(c => c.id);

    // 2. Récupérer tous les utilisateurs avec leurs points cumulés sur ces compétitions
    const predictions = await prisma.podiumPrediction.findMany({
      where: {
        competitionId: { in: competitionIds }
      },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      }
    });

    // 3. Agréger les points par utilisateur
    const leaderboardMap = {};

    predictions.forEach(pred => {
      const userId = pred.user.id;
      if (!leaderboardMap[userId]) {
        leaderboardMap[userId] = {
          user: pred.user,
          totalPoints: 0,
          podiumsCount: 0
        };
      }
      leaderboardMap[userId].totalPoints += pred.pointsEarned || 0;
      leaderboardMap[userId].podiumsCount += 1;
    });

    // Transformer en tableau et trier du plus grand au plus petit nombre de points
    const leaderboard = Object.values(leaderboardMap).sort((a, b) => b.totalPoints - a.totalPoints);

    res.json(leaderboard);
  } catch (error) {
    console.error("Erreur leaderboard tournoi:", error);
    res.status(500).json({ error: "Erreur lors du calcul du classement général." });
  }
});

module.exports = router;