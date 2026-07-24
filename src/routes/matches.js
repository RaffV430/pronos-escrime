const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { processMatchResult, processPodiumResult } = require('../services/pointsService');

// Valider le score réel d'un match (Admin)
router.post('/:id/result', authMiddleware, async (req, res) => {
  try {
    const { score1, score2 } = req.body;
    const matchId = req.params.id;

    if (score1 === undefined || score2 === undefined) {
      return res.status(400).json({ error: 'Les deux scores sont requis' });
    }

    const updatedMatch = await processMatchResult(matchId, parseInt(score1, 10), parseInt(score2, 10));

    res.json({
      message: 'Résultat du match enregistré et points distribués avec succès !',
      match: updatedMatch,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors du traitement du résultat' });
  }
});

// Valider le podium officiel d'une compétition (Admin)
router.post('/competition/:id/podium-result', authMiddleware, async (req, res) => {
  try {
    const { gold, silver, bronze1, bronze2 } = req.body;
    const competitionId = req.params.id;

    await processPodiumResult(competitionId, { gold, silver, bronze1, bronze2 });

    res.json({ message: 'Podium validé et points attribués aux parieurs !' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la validation du podium' });
  }
});

module.exports = router;