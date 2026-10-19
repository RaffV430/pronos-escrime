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
  // Équipes suivies dans une épreuve par équipes.
  router.get(
    '/teams',
    run(async (req, res) => {
      if (!validId(req.query.competitionId)) return res.status(400).json({ error: 'Épreuve invalide.' });
      const competition = await db.competition.findUnique({
        where: { id: Number(req.query.competitionId) },
        select: { id: true, podiumFormat: true, podiumRoster: true },
      });
      if (!competition) return res.status(404).json({ error: 'Épreuve introuvable.' });
      res.json(await require('../services/teamFollows').forCompetition(db, req.user.userId, competition));
    }),
  );
  router.post(
    '/teams',
    run(async (req, res) => {
      const { competitionId, entryId } = req.body || {};
      if (!validId(competitionId) || typeof entryId !== 'string' || !entryId || entryId.length > 200)
        return res.status(400).json({ error: 'Équipe invalide.' });
      res
        .status(201)
        .json(await require('../services/teamFollows').follow(db, req.user.userId, Number(competitionId), entryId));
    }),
  );
  router.delete(
    '/teams/:id',
    run(async (req, res) => {
      if (!validId(req.params.id)) return res.status(400).json({ error: 'Équipe invalide.' });
      res.json(await require('../services/teamFollows').remove(db, req.user.userId, Number(req.params.id)));
    }),
  );
  router.get(
    '/:id/history',
    run(async (req, res) => {
      if (!validId(req.params.id)) return res.status(400).json({ error: 'Favori invalide.' });
      res.json(await require('../services/fencerHistory').history(db, req.user.userId, Number(req.params.id)));
    }),
  );
  // Toutes les épreuves du tireur suivi, saison par saison (?season=2026-2027 ou all).
  router.get(
    '/:id/season',
    run(async (req, res) => {
      if (!validId(req.params.id)) return res.status(400).json({ error: 'Favori invalide.' });
      res.json(
        await require('../services/fencerSeason').fencerSeason(
          db,
          req.user.userId,
          Number(req.params.id),
          req.query.season ?? null,
        ),
      );
    }),
  );
  router.get(
    '/directory',
    run(async (req, res) => {
      const { tournamentId, competitionId, query = '', clubOnly, clubId, category, offset = '0' } = req.query;
      if (
        (tournamentId !== undefined && !validId(tournamentId)) ||
        (competitionId !== undefined && !validId(competitionId)) ||
        (category !== undefined && (typeof category !== 'string' || !/^[A-Z0-9_-]{1,24}$/.test(category))) ||
        typeof query !== 'string' ||
        query.length > 160 ||
        (clubOnly !== undefined && clubOnly !== '1') ||
        (clubId !== undefined && !validId(clubId)) ||
        !/^\d{1,6}$/.test(String(offset))
      )
        return res.status(400).json({ error: 'Recherche de tireurs invalide.' });
      res.json(
        await require('../services/fencerDirectory').search(db, req.user.userId, {
          tournamentId: Number(tournamentId) || null,
          category,
          competitionId: Number(competitionId) || null,
          query,
          clubOnly: clubOnly === '1',
          clubId: Number(clubId) || null,
          offset: Number(offset),
        }),
      );
    }),
  );
  router.post(
    '/',
    run(async (req, res) => {
      if (req.body.affiliationId !== undefined) {
        if (!validId(req.body.affiliationId) || req.body.competitionId !== undefined || req.body.entryId !== undefined)
          return res.status(400).json({ error: 'Sélection de tireur invalide.' });
        return res.json(await follows.followProfile(db, req.user.userId, Number(req.body.affiliationId)));
      }
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
