const router = require('express').Router();
const prisma = require('../lib/prisma');
const { id, fail } = require('../services/poolRules');
router.use(require('../middleware/auth'), require('../middleware/admin'));
const { reportError } = require('../lib/report');
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    reportError(e, 'admin');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Opération impossible.' });
  }
};
router.get(
  '/users',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2 && !/^[1-9]$/.test(q)) return res.json([]);
    res.json(
      await prisma.user.findMany({
        where: /^[1-9]\d*$/.test(q) ? { id: id(q) } : { name: { contains: q, mode: 'insensitive' } },
        select: { id: true, name: true },
        take: 20,
        orderBy: { name: 'asc' },
      }),
    );
  }),
);
// Journal d'administration : par défaut sans les contrôles automatiques FencingTimeLive
// (un toutes les 2 min par épreuve), qui noyaient les actions des administrateurs. ?all=1 pour tout voir.
const ROUTINE = ['Contrôle FTL démarré', 'Contrôle FTL terminé'];
router.get(
  '/audit',
  wrap(async (req, res) =>
    res.json(
      await prisma.auditLog.findMany({
        where: req.query.all === '1' ? {} : { action: { notIn: ROUTINE } },
        orderBy: { id: 'desc' },
        take: 100,
      }),
    ),
  ),
);
// Animation : participation au tournoi, joueurs sans pronostic, relance en un clic.
router.get(
  '/engagement/:tournamentId',
  wrap(async (req, res) =>
    res.json(await require('../services/engagement').engagement(prisma, id(req.params.tournamentId))),
  ),
);
router.post(
  '/engagement/:competitionId/remind',
  wrap(async (req, res) =>
    res.json(await require('../services/engagement').remind(prisma, id(req.params.competitionId), req.user.userId)),
  ),
);
// Circuits : classements cumulés sur plusieurs tournois.
router.get(
  '/circuits',
  wrap(async (req, res) => res.json(await require('../services/circuits').getCircuits(prisma))),
);
router.put(
  '/circuits',
  wrap(async (req, res) =>
    res.json(await require('../services/circuits').saveCircuits(prisma, req.body?.circuits, req.user.userId)),
  ),
);
// Matrices complètes des poules d'une épreuve déjà importée (même archivée) : lecture seule de la source.
router.post(
  '/pool-bouts/:competitionId',
  wrap(async (req, res) =>
    res.json(await require('../services/poolBoutsBackfill').backfillBouts(prisma, id(req.params.competitionId))),
  ),
);
// Club : nom et liste des tireurs mis en avant ; enregistrer crée aussi les ligues du club manquantes.
router.get(
  '/club',
  wrap(async (req, res) => res.json(await require('../services/club').getClub(prisma))),
);
router.put(
  '/club',
  wrap(async (req, res) => {
    const club = require('../services/club');
    const before = (await club.getClub(prisma)).name;
    const saved = await club.saveClub(prisma, req.body, req.user.userId);
    // Nouveau nom : le club permanent est renommé (membres conservés).
    if (before && saved.name && before !== saved.name)
      await prisma.league.updateMany({
        where: { kind: 'CLUB', name: before, archivedAt: null },
        data: { name: saved.name },
      });
    const league = await require('../services/groups').ensureAppClub(prisma, { actorId: req.user.userId });
    res.json({ ...saved, leaguesCreated: league ? 1 : 0 });
  }),
);
// État du suivi automatique de chaque épreuve (erreurs, retards, dernier contrôle).
router.get(
  '/sync-health',
  wrap(async (req, res) => res.json(await require('../services/syncHealth').syncHealth(prisma))),
);
router.get(
  '/adjustments',
  wrap(async (req, res) =>
    res.json(
      await prisma.pointAdjustment.findMany({
        orderBy: { id: 'desc' },
        take: 100,
        include: { user: { select: { name: true } } },
      }),
    ),
  ),
);
router.post(
  '/adjust-points',
  wrap(async (req, res) => {
    const key = req.body.requestKey;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key))
      fail('Identifiant de demande requis. Réessayez depuis le formulaire.');
    const points =
      typeof req.body.points === 'string' && /^-?\d+$/.test(req.body.points)
        ? Number(req.body.points)
        : req.body.points;
    if (!Number.isInteger(points) || !points || Math.abs(points) > 10000)
      fail('Nombre de points non nul entre -10000 et 10000 requis.');
    const userId = req.body.userId ? id(req.body.userId) : null,
      name = String(req.body.name || '')
        .normalize('NFC')
        .trim();
    if ((!userId && !name) || (userId && name)) fail('Choisissez un joueur par ID ou par nom.');
    const competitionId = req.body.competitionId ? id(req.body.competitionId) : null;
    let tournamentId = req.body.tournamentId ? id(req.body.tournamentId) : null;
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3 || reason.length > 250) fail('Indiquez une raison entre 3 et 250 caractères.');
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${req.user.userId} FOR UPDATE`;
      const previous = await tx.pointAdjustment.findUnique({ where: { requestKey: key } });
      const users = await tx.user.findMany({
        where: userId ? { id: userId } : { name: { equals: name, mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      if (users.length !== 1)
        fail(users.length ? 'Nom ambigu : utilisez l’ID.' : 'Joueur introuvable.', users.length ? 409 : 404);
      if (competitionId) {
        const c = await tx.competition.findUnique({ where: { id: competitionId } });
        if (!c) fail('Épreuve introuvable.', 404);
        if (tournamentId && c.tournamentId !== tournamentId) fail('Cette épreuve ne correspond pas au tournoi.');
        tournamentId = c.tournamentId;
      } else if (tournamentId && !(await tx.tournament.findUnique({ where: { id: tournamentId } })))
        fail('Tournoi introuvable.', 404);
      if (previous) {
        if (
          previous.actorId !== req.user.userId ||
          previous.userId !== users[0].id ||
          previous.points !== points ||
          previous.reason !== reason ||
          previous.competitionId !== competitionId ||
          previous.tournamentId !== tournamentId
        )
          fail('Cette demande a déjà été utilisée avec un autre contenu.', 409);
        return previous;
      }
      const adjustment = await tx.pointAdjustment.create({
        data: {
          userId: users[0].id,
          points,
          reason,
          tournamentId,
          competitionId,
          requestKey: key,
          actorId: req.user.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.userId,
          action: 'Ajustement de points',
          targetType: 'PointAdjustment',
          targetId: adjustment.id,
          after: { userId: users[0].id, points, reason, tournamentId, competitionId },
        },
      });
      return adjustment;
    });
    res.json({ success: true, adjustment: result });
  }),
);
// Lieu de compétition : recherche d'une ville, le fuseau horaire en est déduit.
router.get(
  '/ftl/cities',
  wrap(async (req, res) => res.json(await require('../services/venue').searchCities(req.query.q))),
);
router.post(
  '/ftl/preview',
  wrap(async (req, res) =>
    res.json(await require('../services/ftlConfiguration').preview(prisma, req.body, req.user.userId)),
  ),
);
router.post(
  '/ftl/configure',
  wrap(async (req, res) =>
    res.json(await require('../services/ftlConfiguration').save(prisma, req.body, req.user.userId)),
  ),
);
router.get(
  '/ftl/configuration/:competitionId',
  wrap(async (req, res) =>
    res.json(await require('../services/ftlConfiguration').configuration(prisma, id(req.params.competitionId))),
  ),
);
// Lieu, date et jour de chaque phase d'une épreuve (correction manuelle, prise en compte au prochain contrôle).
router.get(
  '/competitions/:competitionId/schedule',
  wrap(async (req, res) => {
    const competitionId = id(req.params.competitionId);
    const schedule = require('../services/schedule');
    const config = await require('../services/ftlConfiguration').configuration(prisma, competitionId);
    const correction = await schedule.correctionOf(prisma, competitionId);
    const merged = config || correction || {};
    res.json({
      configured: Boolean(config),
      city: merged.city || null,
      timezone: merged.timezone || null,
      country: merged.country || null,
      date: merged.date || null,
      phases: await schedule.phases(prisma, competitionId, merged),
    });
  }),
);
router.put(
  '/competitions/:competitionId/schedule',
  wrap(async (req, res) => {
    const competitionId = id(req.params.competitionId);
    const schedule = require('../services/schedule');
    if (!(await prisma.competition.findUnique({ where: { id: competitionId }, select: { id: true } })))
      fail('Épreuve introuvable.', 404);
    const previous = (await schedule.correctionOf(prisma, competitionId)) || {};
    const after = schedule.validateCorrection(req.body || {}, previous);
    await prisma.auditLog.create({
      data: {
        actorId: req.user.userId,
        action: schedule.CORRECTION,
        targetType: 'Competition',
        targetId: competitionId,
        before: previous,
        after,
      },
    });
    res.json({ saved: true, ...after });
  }),
);
router.post(
  '/ftl/tournament/preview',
  wrap(async (req, res) =>
    res.json(await require('../services/ftlTournament').preview(prisma, req.body, req.user.userId)),
  ),
);
router.post(
  '/ftl/tournament/configure',
  wrap(async (req, res) =>
    res.json(await require('../services/ftlTournament').save(prisma, req.body, req.user.userId)),
  ),
);

// Calendrier : passage immédiat de la surveillance FencingTimeLive / engarde-service, et état de chaque épreuve.
router.post(
  '/calendar/watch',
  wrap(async (req, res) => res.json(await require('../services/calendarWatch').watch(prisma))),
);
router.get(
  '/calendar',
  wrap(async (req, res) => {
    const last = await prisma.auditLog.findFirst({
      where: { action: 'Calendrier : surveillance' },
      orderBy: { id: 'desc' },
      select: { createdAt: true, after: true },
    });
    res.json({ events: await require('../services/calendarWatch').upcoming(prisma), last });
  }),
);

// Archivage d'un tournoi entier depuis l'administration.
router.get(
  '/tournaments/:tournamentId/archive',
  wrap(async (req, res) => {
    const status = await require('../services/tournamentArchive').archiveStatus(prisma, id(req.params.tournamentId));
    if (!status) return res.status(404).json({ error: 'Tournoi introuvable.' });
    res.json(status);
  }),
);
router.post(
  '/tournaments/:tournamentId/archive',
  wrap(async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirmation requise.' });
    res.json(
      await require('../services/tournamentArchive').archiveManually(
        prisma,
        id(req.params.tournamentId),
        req.user.userId,
      ),
    );
  }),
);
router.post(
  '/tournaments/:tournamentId/unarchive',
  wrap(async (req, res) => {
    res.json(
      await require('../services/tournamentArchive').unarchive(prisma, id(req.params.tournamentId), req.user.userId),
    );
  }),
);

module.exports = router;
