const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { podiumClosed } = require('../lib/matchLock');
async function isClosed(tx, competition) {
  return podiumClosed(competition, await tx.match.findMany({ where: { competitionId: competition.id } }));
}

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
    res.json({ isLocked: competition ? await isClosed(prisma, competition) : false });
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
    const competition = await prisma.competition.findUnique({ where: { id: compId } });
    if (!competition) return res.status(404).json({ error: 'Compétition introuvable.' });
    if (!(await isClosed(prisma, competition)) && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Les pronostics seront visibles après leur clôture.' });
    }
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
      include: { user: { select: { id: true, name: true } } }
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
router.put('/competition/:competitionId/toggle-lock', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Accès non autorisé." });
    const compId = parseInt(req.params.competitionId, 10);
    const { isLocked } = req.body;

    if (!Number.isInteger(compId) || typeof isLocked !== 'boolean') return res.status(400).json({ error: 'Verrouillage invalide.' });
    const updatedCompetition = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${compId} FOR UPDATE`;
      return tx.competition.update({ where: { id: compId }, data: { isPodiumLocked: isLocked, podiumManualUnlock: !isLocked } });
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
    if (new Set(officialAll).size !== 4) {
      return res.status(400).json({ error: 'Les quatre médaillés doivent être différents.' });
    }
    const officialBronzes = [offBronze1, offBronze2];

    // Récupérer tous les pronostics pour cette compétition
    const predictions = await prisma.podiumPrediction.findMany({
      where: { competitionId: compId }
    });

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${compId} FOR UPDATE`;
      for (const pred of predictions) {
        let points = 0;
        const pGold = normalize(pred.gold);
        const pSilver = normalize(pred.silver);
        const pBronze1 = normalize(pred.bronze1);
        const pBronze2 = normalize(pred.bronze2);

        if (pGold === offGold) points += 15;
        else if (officialAll.includes(pGold)) points += 5;
        if (pSilver === offSilver) points += 15;
        else if (officialAll.includes(pSilver)) points += 5;
        if (officialBronzes.includes(pBronze1)) points += 15;
        else if (officialAll.includes(pBronze1)) points += 5;
        if (officialBronzes.includes(pBronze2)) points += 15;
        else if (officialAll.includes(pBronze2)) points += 5;

        await tx.podiumPrediction.update({ where: { id: pred.id }, data: { pointsEarned: points } });
      }
      await tx.competition.update({ where: { id: compId }, data: { isPodiumLocked: true, podiumManualUnlock: false } });
    });

    res.json({ message: `🎯 Podium officiel validé ! Les points de ${predictions.length} joueurs ont été calculés et mis à jour.`, updateCount: predictions.length });

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
    const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${compId} FOR UPDATE`;
    const competition = await tx.competition.findUnique({ where: { id: compId } });
    
    if (!competition) return { status: 404, body: { error: "Compétition introuvable." } };
    if (await isClosed(tx, competition)) return { status: 403, body: { error: "Les pronostics sont verrouillés." } };

    const normalizedPodium = [gold, silver, bronze1, bronze2]
      .map((name) => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase());
    if (normalizedPodium.some((name) => name.length > 100) || new Set(normalizedPodium).size !== 4) {
      return { status: 400, body: { error: 'Les quatre tireurs doivent être différents et valides.' } };
    }

    const prediction = await tx.podiumPrediction.upsert({
      where: { userId_competitionId: { userId: req.user.userId, competitionId: compId } },
      update: { gold, silver, bronze1, bronze2 },
      create: { userId: req.user.userId, competitionId: compId, gold, silver, bronze1, bronze2 }
    });
    return { status: 200, body: { message: "Pronostic de podium enregistré avec succès !", prediction } };
    });
    res.status(result.status).json(result.body);
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
