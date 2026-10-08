const express = require('express');
const follows = require('../services/fencerFollows');
function createRouter(db) {
  const router = express.Router();
  router.use(require('../middleware/auth'));
  const validId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const run = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Suivi des tireurs indisponible.' });
    }
  };
  router.get(
    '/',
    run(async (req, res) => {
      if (req.query.competitionId !== undefined && !validId(req.query.competitionId))
        return res.status(400).json({ error: 'Épreuve invalide.' });
      res.json(await follows.list(db, req.user.userId, Number(req.query.competitionId) || null));
    }),
  );
  router.get(
    '/directory',
    run(async (req, res) => {
      const { tournamentId, competitionId, query = '', clubOnly, offset = '0' } = req.query;
      if (
        !validId(tournamentId) ||
        (competitionId !== undefined && !validId(competitionId)) ||
        typeof query !== 'string' ||
        query.length > 160 ||
        (clubOnly !== undefined && clubOnly !== '1') ||
        !/^\d{1,6}$/.test(String(offset))
      )
        return res.status(400).json({ error: 'Recherche de tireurs invalide.' });
      res.json(
        await require('../services/fencerDirectory').search(db, req.user.userId, {
          tournamentId: Number(tournamentId),
          competitionId: Number(competitionId) || null,
          query,
          clubOnly: clubOnly === '1',
          offset: Number(offset),
        }),
      );
    }),
  );
  router.post(
    '/',
    run(async (req, res) => {
      if (
        !validId(req.body.competitionId) ||
        typeof req.body.entryId !== 'string' ||
        !req.body.entryId ||
        req.body.entryId.length > 160
      )
        return res.status(400).json({ error: 'Sélection de tireur invalide.' });
      res.json(await follows.follow(db, req.user.userId, Number(req.body.competitionId), req.body.entryId));
    }),
  );
  router.post(
    '/import',
    run(async (req, res) => {
      const items = req.body.items;
      if (
        !Array.isArray(items) ||
        items.length > 200 ||
        items.some(
          (e) =>
            !e ||
            !['string', 'number'].includes(typeof e.id) ||
            String(e.id).length > 160 ||
            typeof e.name !== 'string' ||
            e.name.length > 160 ||
            (e.country !== undefined && typeof e.country !== 'string'),
        )
      )
        return res.status(400).json({ error: 'Favoris locaux invalides.' });
      res.json(await follows.importLocal(db, req.user.userId, items));
    }),
  );
  router.delete(
    '/:id',
    run(async (req, res) => {
      if (!validId(req.params.id)) return res.status(400).json({ error: 'Favori invalide.' });
      const result = await db.followedFencer.deleteMany({
        where: { id: Number(req.params.id), userId: req.user.userId },
      });
      if (!result.count) return res.status(404).json({ error: 'Favori introuvable.' });
      res.json({ removed: true });
    }),
  );
  return router;
}
module.exports = { createRouter };
