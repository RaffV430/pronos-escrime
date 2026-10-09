const express = require('express');
const service = require('../services/fencerAffiliations');
function createRouter(db) {
  const router = express.Router();
  router.use(require('../middleware/auth'), require('../middleware/admin').createAdminMiddleware(db));
  const run = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Affiliations indisponibles.' });
    }
  };
  router.get(
    '/',
    run(async (req, res) => {
      if (typeof req.query.q !== 'string' || req.query.q.length < 2 || req.query.q.length > 160)
        return res.status(400).json({ error: 'Deux caractères minimum.' });
      res.json(
        await db.fencerAffiliation.findMany({
          where: { nameKey: { contains: service.key(req.query.q) } },
          orderBy: { name: 'asc' },
          take: 50,
        }),
      );
    }),
  );
  router.get(
    '/:id/history',
    run(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Tireur invalide.' });
      res.json(
        await db.fencerAffiliationHistory.findMany({
          where: { affiliationId: id },
          orderBy: { id: 'desc' },
          take: 100,
        }),
      );
    }),
  );
  router.put(
    '/:id',
    run(async (req, res) => res.json(await service.manual(db, Number(req.params.id), req.body, req.user.userId))),
  );
  return router;
}
module.exports = { createRouter };
