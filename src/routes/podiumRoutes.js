const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { roster, validateSelection, verifiedPodium, resolvePodium } = require('../services/podiumRules');
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
    if (!(await isClosed(prisma, competition)) && !(await prisma.user.findUnique({ where: { id: req.user.userId }, select: { isAdmin: true } }))?.isAdmin) {
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
router.post('/competition/:competitionId/resolve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const compId = Number(req.params.competitionId);
    if (!Number.isInteger(compId) || compId < 1) return res.status(400).json({ error: 'Compétition invalide.' });
    // Client-entered names are never used as an official result.
    const updateCount = await prisma.$transaction(tx => resolvePodium(tx, compId));
    res.json({ message: `Podium officiel vérifié : points de ${updateCount} joueur(s) recalculés.`, updateCount });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors du calcul des points.' }); }
});

router.get('/options/:competitionId', authMiddleware, async (req, res) => {
  try {
    const competition = await prisma.competition.findUnique({ where: { id: Number(req.params.competitionId) } });
    if (!competition) return res.status(404).json({ error: 'Compétition introuvable.' });
    const entries = roster(competition).slice().sort((a,b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }) || a.country.localeCompare(b.country) || a.id.localeCompare(b.id));
    let official = null;
    try { official = verifiedPodium(competition); } catch { /* Await a complete verified result. */ }
    res.json({ format: competition.podiumFormat, entries, sourceUrl: competition.rosterSourceUrl, official, resultsSourceUrl: competition.resultsSourceUrl, resultsVerifiedAt: competition.resultsVerifiedAt, resolvedAt: competition.podiumResolvedAt });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Liste des engagés indisponible.' }); }
});

// ---------------------------------------------------------
// 6. POST : Enregistrer un pronostic de podium
// ---------------------------------------------------------
router.post('/', authMiddleware, async (req, res) => {
  try {
    const compId = Number(req.body.competitionId);
    if (!Number.isInteger(compId) || compId < 1) return res.status(400).json({ error: 'Compétition invalide.' });
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${compId} FOR UPDATE`;
      const competition = await tx.competition.findUnique({ where: { id: compId } });
      if (!competition) return { status: 404, body: { error: 'Compétition introuvable.' } };
      if (await isClosed(tx, competition)) return { status: 403, body: { error: 'Les pronostics sont verrouillés.' } };
      const selection = validateSelection(competition, req.body.selectionIds);
      const data = { ...selection.names, selectionIds: selection.ids };
      const prediction = await tx.podiumPrediction.upsert({
        where: { userId_competitionId: { userId: req.user.userId, competitionId: compId } },
        update: data, create: { userId: req.user.userId, competitionId: compId, ...data }
      });
      return { status: 200, body: { message: 'Pronostic de podium enregistré.', prediction } };
    });
    res.status(result.status).json(result.body);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Erreur lors de l’enregistrement du podium.' }); }
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
