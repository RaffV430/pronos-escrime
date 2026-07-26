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
    res.status(500).json({ error: "Erreur lors de la récupération des compétitions." });
  }
});

// ---------------------------------------------------------
// 1. GET : Récupérer le statut d'une compétition spécifique
// ---------------------------------------------------------
router.get('/competition-status/:competitionId', authMiddleware, async (req, res) => {
  try {
    const compId = parseInt(req.params.competitionId, 10);
    const competition = await prisma.competition.findUnique({
      where: { id: compId }
    });
    res.json({ isLocked: competition ? competition.isPodiumLocked : false });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération du statut." });
  }
});

// ---------------------------------------------------------
// 2. GET : Récupérer les pronostics de tous les utilisateurs
// ---------------------------------------------------------
router.get('/all/competition/:competitionId', authMiddleware, async (req, res) => {
  const { competitionId } = req.params;
  try {
    const compId = parseInt(competitionId, 10);
    const allPredictions = await prisma.podiumPrediction.findMany({
      where: { competitionId: compId },
      include: { user: { select: { name: true } } }
    });
    res.json(allPredictions);
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de la récupération des pronostics." });
  }
});

// ---------------------------------------------------------
// 3. GET : Classement général du tournoi
// ---------------------------------------------------------
router.get('/leaderboard/:tournamentId', authMiddleware, async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.tournamentId, 10);
    const competitions = await prisma.competition.findMany({
      where: { tournamentId },
      select: { id: true }
    });
    const competitionIds = competitions.map(c => c.id);

    const predictions = await prisma.podiumPrediction.findMany({
      where: { competitionId: { in: competitionIds } },
      include: { user: { select: { id: true, name: true, email: true } } }
    });

    const leaderboardMap = {};
    predictions.forEach(pred => {
      const userId = pred.user.id;
      if (!leaderboardMap[userId]) {
        leaderboardMap[userId] = { user: pred.user, totalPoints: 0, podiumsCount: 0 };
      }
      leaderboardMap[userId].totalPoints += pred.pointsEarned || 0;
      leaderboardMap[userId].podiumsCount += 1;
    });

    const leaderboard = Object.values(leaderboardMap).sort((a, b) => b.totalPoints - a.totalPoints);
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: "Erreur lors du calcul du classement général." });
  }
});

// ---------------------------------------------------------
// 4. PUT : Verrouiller / Déverrouiller une compétition (Admin)
// ---------------------------------------------------------
router.put('/competition/:competitionId/toggle-lock', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Accès non autorisé." });
    const compId = parseInt(req.params.competitionId, 10);
    const { isLocked } = req.body;

    const updatedCompetition = await prisma.competition.update({
      where: { id: compId },
      data: { isPodiumLocked: isLocked }
    });
    res.json({ message: `Pronostics ${isLocked ? 'verrouillés' : 'ouverts'} pour cette compétition.`, competition: updatedCompetition });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur lors de la modification du verrouillage' });
  }
});

// ---------------------------------------------------------
// 5. POST : Valider le podium officiel et calculer les points (ADMIN)
// ---------------------------------------------------------
router.post('/competition/:competitionId/resolve', authMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Accès non autorisé." });

    const compId = parseInt(req.params.competitionId, 10);
    const { gold, silver, bronze1, bronze2 } = req.body;

    if (!gold || !silver || !bronze1 || !bronze2) {
      return res.status(400).json({ error: "Tous les médaillés officiels sont requis." });
    }

    // Fonction pour nettoyer les noms (enlève les accents, les espaces superflus et met en minuscules)
    const normalize = (str) => str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase() : "";

    const offGold = normalize(gold);
    const offSilver = normalize(silver);
    const offBronze1 = normalize(bronze1);
    const offBronze2 = normalize(bronze2);
    
    const officialAll = [offGold, offSilver, offBronze1, offBronze2];
    const officialBronzes = [offBronze1, offBronze2];

    // Récupérer tous les pronostics pour cette compétition
    const predictions = await prisma.podiumPrediction.findMany({
      where: { competitionId: compId }
    });

    let updateCount = 0;

    for (const pred of predictions) {
      let points = 0;
      const pGold = normalize(pred.gold);
      const pSilver = normalize(pred.silver);
      const pBronze1 = normalize(pred.bronze1);
      const pBronze2 = normalize(pred.bronze2);

      // Calcul OR
      if (pGold === offGold) points += 15;
      else if (officialAll.includes(pGold)) points += 5;

      // Calcul ARGENT
      if (pSilver === offSilver) points += 15;
      else if (officialAll.includes(pSilver)) points += 5;

      // Calcul BRONZE 1 (Interchangeable)
      if (officialBronzes.includes(pBronze1)) points += 15;
      else if (officialAll.includes(pBronze1)) points += 5;

      // Calcul BRONZE 2 (Interchangeable)
      if (officialBronzes.includes(pBronze2)) points += 15;
      else if (officialAll.includes(pBronze2)) points += 5;

      // Sauvegarde des points dans la base de données
      await prisma.podiumPrediction.update({
        where: { id: pred.id },
        data: { pointsEarned: points }
      });
      updateCount++;
    }

    // On verrouille la compétition automatiquement
    await prisma.competition.update({
      where: { id: compId },
      data: { isPodiumLocked: true }
    });

    res.json({ message: `🎯 Podium officiel validé ! Les points de ${updateCount} joueurs ont été calculés et mis à jour.`, updateCount });

  } catch (err) {
    console.error("Erreur résolution podium:", err);
    res.status(500).json({ error: "Erreur lors du calcul des points." });
  }
});

// ---------------------------------------------------------
// 6. POST : Enregistrer un pronostic de podium
// ---------------------------------------------------------
router.post('/', authMiddleware, async (req, res) => {
  const { competitionId, gold, silver, bronze1, bronze2 } = req.body;
  if (!competitionId || !gold || !silver || !bronze1 || !bronze2) {
    return res.status(400).json({ error: "Tous les champs du podium sont requis." });
  }

  try {
    const compId = parseInt(competitionId, 10);
    const competition = await prisma.competition.findUnique({ where: { id: compId } });
    
    if (!competition) return res.status(404).json({ error: "Compétition introuvable." });
    if (competition.isPodiumLocked) return res.status(403).json({ error: "Les pronostics sont verrouillés." });

    const prediction = await prisma.podiumPrediction.upsert({
      where: { userId_competitionId: { userId: req.user.userId, competitionId: compId } },
      update: { gold, silver, bronze1, bronze2 },
      create: { userId: req.user.userId, competitionId: compId, gold, silver, bronze1, bronze2 }
    });
    res.json({ message: "Pronostic de podium enregistré avec succès !", prediction });
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de l'enregistrement du podium." });
  }
});

// ---------------------------------------------------------
// 7. GET : Récupérer son propre pronostic (TOUJOURS À LA FIN)
// ---------------------------------------------------------
router.get('/:competitionId', authMiddleware, async (req, res) => {
  try {
    const compId = parseInt(req.params.competitionId, 10);
    const prediction = await prisma.podiumPrediction.findUnique({
      where: { userId_competitionId: { userId: req.user.userId, competitionId: compId } }
    });
    res.json(prediction || {});
  } catch (err) {
    res.status(500).json({ error: "Erreur lors du chargement du podium." });
  }
});

module.exports = router;