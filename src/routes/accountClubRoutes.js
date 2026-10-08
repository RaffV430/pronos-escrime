const express = require('express');
const service = require('../services/accountClubs');
function createRouter(db) {
  const router = express.Router();
  const auth = require('../middleware/auth');
  const admin = require('../middleware/admin').createAdminMiddleware(db);
  const run = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : 'Service clubs indisponible. Réessayez.' });
    }
  };
  router.get(
    '/',
    run(async (req, res) => {
      if (req.query.q && (typeof req.query.q !== 'string' || req.query.q.length > 120))
        return res.status(400).json({ error: 'Recherche invalide.' });
      res.json(await service.directory(db, req.query.q));
    }),
  );
  router.get(
    '/me',
    auth,
    run(async (req, res) => res.json(await service.profile(db, req.user.userId))),
  );
  router.put(
    '/me',
    auth,
    run(async (req, res) => res.json(await service.setClub(db, req.user.userId, req.body))),
  );
  router.post(
    '/me/responsibility',
    auth,
    run(async (req, res) => res.json(await service.requestRole(db, req.user.userId, req.body.reason))),
  );
  router.put(
    '/me/presentation',
    auth,
    run(async (req, res) => res.json(await service.updatePresentation(db, req.user.userId, req.body.description))),
  );
  router.get(
    '/admin/responsibilities',
    auth,
    admin,
    run(async (req, res) =>
      res.json(
        await db.clubResponsibility.findMany({
          include: { club: true, user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
      ),
    ),
  );
  router.get(
    '/admin/members/:clubId',
    auth,
    admin,
    run(async (req, res) => {
      const clubId = Number(req.params.clubId);
      if (!service.positive(clubId)) return res.status(400).json({ error: 'Club invalide.' });
      res.json(
        await db.user.findMany({ where: { clubId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      );
    }),
  );
  router.put(
    '/admin/responsibility',
    auth,
    admin,
    run(async (req, res) =>
      res.json(await service.decideRole(db, req.user.userId, req.body.userId, req.body.clubId, req.body.status)),
    ),
  );
  router.put(
    '/admin/:id/verify',
    auth,
    admin,
    run(async (req, res) => {
      const id = Number(req.params.id);
      if (!service.positive(id)) return res.status(400).json({ error: 'Club invalide.' });
      const club = await db.club.update({ where: { id }, data: { status: 'VERIFIED' } });
      await db.auditLog.create({
        data: { actorId: req.user.userId, action: 'CLUB_VERIFIED', targetType: 'Club', targetId: id, after: club },
      });
      res.json(club);
    }),
  );
  return router;
}
module.exports = { createRouter };
