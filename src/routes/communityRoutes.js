const router = require('express').Router(),
  crypto = require('crypto');
const db = require('../lib/prisma');
const { fail, id } = require('../services/poolRules');
const { title, challengePoints, clubScore } = require('../services/communityRules');
const { standings } = require('../services/standings');
const { rankRows } = require('../services/ranking');
const { buildDuel } = require('../services/duel');
router.use(require('../middleware/auth'));
router.use(
  require('express-rate-limit').rateLimit({
    windowMs: 60000,
    limit: 90,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
);
const { reportError } = require('../lib/report');
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    reportError(e, 'community');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Service indisponible. Réessayez.' });
  }
};
async function clubOpen(tx, league) {
  if (league.kind !== 'CLUB') return;
  const matches = await tx.match.findMany({ where: { competition: { tournamentId: league.tournamentId } } });
  const poolsStarted = await tx.pool.findFirst({
    where: {
      competition: { tournamentId: league.tournamentId },
      OR: [{ isFinal: true }, { fencers: { some: { firstResultAt: { not: null } } } }],
    },
  });
  if (
    poolsStarted ||
    new Date(league.startsAt) <= new Date() ||
    matches.some((m) => m.isFinished || (m.startsAt && new Date(m.startsAt) <= new Date()))
  )
    fail('Les inscriptions des clubs sont closes pour ce tournoi.', 409);
}
async function enroll(tx, league, userId) {
  await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${league.tournamentId} FOR UPDATE`;
  await clubOpen(tx, league);
  if (league.kind === 'CLUB') {
    const other = await tx.leagueMember.findFirst({
      where: { userId, league: { kind: 'CLUB', tournamentId: league.tournamentId }, NOT: { leagueId: league.id } },
    });
    if (other) fail('Un seul club par joueur et par tournoi.', 409);
  }
  return tx.leagueMember.upsert({
    where: { leagueId_userId: { leagueId: league.id, userId } },
    update: {},
    create: { leagueId: league.id, userId },
  });
}
// Circuits (classements cumulés sur une série de tournois).
router.get(
  '/circuits',
  wrap(async (req, res) => {
    const circuits = await require('../services/circuits').getCircuits(db);
    res.json(
      circuits.map(({ id, name, tournamentIds, dropWorst }) => ({
        id,
        name,
        tournaments: tournamentIds.length,
        dropWorst,
      })),
    );
  }),
);
router.get(
  '/circuits/:id',
  wrap(async (req, res) => res.json(await require('../services/circuits').circuitRanking(db, id(req.params.id)))),
);
// Club de l'application : tireurs mis en avant et ligue du club de chaque tournoi (créée automatiquement).
let clubCheckedAt = 0;
router.get(
  '/club',
  wrap(async (req, res) => {
    const club = require('../services/club');
    if (Date.now() - clubCheckedAt > 5 * 60000) {
      clubCheckedAt = Date.now();
      await club.ensureClubLeagues(db).catch((e) => reportError(e, 'ligue du club'));
    }
    const { name, fencers } = await club.getClub(db);
    const leagues = name
      ? await db.league.findMany({
          where: { kind: 'CLUB', name, tournament: { archivedAt: null } },
          select: { id: true, tournamentId: true, startsAt: true, members: { where: { userId: req.user.userId } } },
        })
      : [];
    res.json({
      name,
      fencers,
      leagues: leagues.map((l) => ({
        leagueId: l.id,
        tournamentId: l.tournamentId,
        member: l.members.length > 0,
        open: new Date(l.startsAt) > new Date(),
      })),
    });
  }),
);
router.post(
  '/club/:tournamentId/join',
  wrap(async (req, res) => {
    const tournamentId = id(req.params.tournamentId);
    const { name } = await require('../services/club').getClub(db);
    const league = name ? await db.league.findFirst({ where: { kind: 'CLUB', name, tournamentId } }) : null;
    if (!league) fail('Pas de ligue du club pour ce tournoi.', 404);
    await db.$transaction((tx) => enroll(tx, league, req.user.userId));
    res.json({ leagueId: league.id, message: `Bienvenue dans la ligue « ${league.name} ».` });
  }),
);
router.get(
  '/leagues',
  wrap(async (req, res) =>
    res.json(
      await db.league.findMany({
        where: { members: { some: { userId: req.user.userId } } },
        include: { _count: { select: { members: true } } },
        orderBy: { id: 'desc' },
      }),
    ),
  ),
);
router.post(
  '/leagues',
  wrap(async (req, res) => {
    const name = title(req.body.name),
      tournamentId = id(req.body.tournamentId),
      kind = req.body.kind;
    if (!['PRIVATE', 'CLUB'].includes(kind)) fail('Type de groupe invalide.');
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
      if (!(await tx.tournament.findUnique({ where: { id: tournamentId } }))) fail('Tournoi introuvable.', 404);
      const matches = await tx.match.findMany({
        where: { competition: { tournamentId } },
        orderBy: { startsAt: 'asc' },
      });
      const dated = matches.filter((m) => m.startsAt),
        startsAt = dated[0]?.startsAt || new Date();
      if (kind === 'CLUB' && (!dated.length || matches.some((m) => m.isFinished) || new Date(startsAt) <= new Date()))
        fail('Un club doit être inscrit avant le premier match du tournoi, dont l’horaire doit être connu.', 409);
      const league = await tx.league.create({
        data: {
          name,
          kind,
          tournamentId,
          startsAt,
          ownerId: req.user.userId,
          code: crypto.randomBytes(12).toString('hex').toUpperCase(),
        },
      });
      await enroll(tx, league, req.user.userId);
      return league;
    });
    res.status(201).json(result);
  }),
);
router.post(
  '/join',
  wrap(async (req, res) => {
    const code = String(req.body.code || '')
      .trim()
      .toUpperCase();
    if (!/^[A-F0-9]{24}$/.test(code)) fail('Code d’invitation invalide.');
    const league = await db.league.findUnique({ where: { code } });
    if (!league) fail('Invitation introuvable.', 404);
    await db.$transaction((tx) => enroll(tx, league, req.user.userId));
    res.json({ success: true, league });
  }),
);
router.post(
  '/leagues/:id/leave',
  wrap(async (req, res) => {
    const league = await db.league.findUnique({ where: { id: id(req.params.id) } });
    if (!league) fail('Ligue introuvable.', 404);
    if (league.ownerId === req.user.userId) fail('Le créateur conserve son inscription.');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${league.tournamentId} FOR UPDATE`;
      await clubOpen(tx, league);
      await tx.leagueMember.deleteMany({ where: { leagueId: league.id, userId: req.user.userId } });
    });
    res.json({ success: true });
  }),
);
router.get(
  '/leagues/:id/duel/:opponentId',
  wrap(async (req, res) => {
    const league = await db.league.findUnique({ where: { id: id(req.params.id) }, include: { members: true } });
    const opponentId = id(req.params.opponentId);
    const userId = req.user.userId;
    if (!league || !league.members.some((m) => m.userId === userId)) fail('Cette ligue est privée.', 403);
    if (opponentId === userId || !league.members.some((m) => m.userId === opponentId))
      fail('Choisissez un autre membre de la ligue.', 404);
    // Uniquement les matchs terminés : aucun pronostic n'est dévoilé avant la fin d'un match.
    const matches = await db.match.findMany({
      where: {
        isFinished: true,
        OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }],
        competition: { tournamentId: league.tournamentId },
      },
      include: { competition: { select: { name: true } } },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const ids = matches.map((m) => m.id);
    const [mine, theirs, opponent] = await Promise.all([
      db.prediction.findMany({ where: { userId, matchId: { in: ids } } }),
      db.prediction.findMany({ where: { userId: opponentId, matchId: { in: ids } } }),
      db.user.findUnique({ where: { id: opponentId }, select: { id: true, name: true } }),
    ]);
    res.json({ league: { id: league.id, name: league.name }, opponent, ...buildDuel(matches, mine, theirs) });
  }),
);
router.get(
  '/leagues/:id',
  wrap(async (req, res) => {
    const league = await db.league.findUnique({ where: { id: id(req.params.id) }, include: { members: true } });
    if (!league || !league.members.some((m) => m.userId === req.user.userId)) fail('Cette ligue est privée.', 403);
    const rows = await standings(db, { tournamentId: league.tournamentId });
    res.json({ league, ranking: rankRows(rows.filter((r) => league.members.some((m) => m.userId === r.id))) });
  }),
);
router.get(
  '/clubs/:tournamentId',
  wrap(async (req, res) => {
    const tournamentId = id(req.params.tournamentId),
      rows = await standings(db, { tournamentId });
    const leagues = await db.league.findMany({ where: { tournamentId, kind: 'CLUB' }, include: { members: true } });
    res.json(
      rankRows(
        leagues
          .map((l) => ({
            id: l.id,
            name: l.name,
            members: l.members.length,
            eligible: l.members.length >= 3,
            totalPoints: clubScore(l.members, rows),
          }))
          .filter((l) => l.eligible),
      ),
    );
  }),
);
router.get(
  '/challenges',
  wrap(async (req, res) => {
    const where = req.query.competitionId ? { competitionId: id(req.query.competitionId) } : {};
    const matches = await db.match.findMany({ where }),
      challenges = await db.challenge.findMany({
        where: { matchId: { in: matches.map((m) => m.id) } },
        include: { picks: { where: { userId: req.user.userId } } },
        orderBy: { closesAt: 'asc' },
      });
    res.json(
      challenges.map((c) => {
        const match = matches.find((m) => m.id === c.matchId),
          pick = c.picks[0];
        return {
          ...c,
          picks: undefined,
          match,
          pick,
          closed:
            match.isFinished ||
            new Date(c.closesAt) <= new Date() ||
            (match.startsAt && new Date(match.startsAt) <= new Date()),
          points: pick ? challengePoints(pick, match, c.bonus) : 0,
        };
      }),
    );
  }),
);
router.post(
  '/challenges',
  require('../middleware/admin'),
  wrap(async (req, res) => {
    const matchId = id(req.body.matchId),
      name = title(req.body.name);
    const challenge = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${matchId} FOR UPDATE`;
      const match = await tx.match.findUnique({ where: { id: matchId } });
      if (!match || match.isFinished || !match.startsAt || new Date(match.startsAt) <= new Date())
        fail('Choisissez un match à venir avec un horaire officiel.', 409);
      if (await tx.challenge.findUnique({ where: { matchId } })) fail('Ce match a déjà un défi.', 409);
      const c = await tx.challenge.create({
        data: { name, matchId, closesAt: match.startsAt, bonus: 3, createdBy: req.user.userId },
      });
      await tx.auditLog.create({
        data: {
          actorId: req.user.userId,
          action: 'Création du défi (règles figées)',
          targetType: 'Challenge',
          targetId: c.id,
          after: { name, matchId, bonus: 3, closesAt: new Date(match.startsAt).toISOString() },
        },
      });
      return c;
    });
    res.status(201).json(challenge);
  }),
);
router.post(
  '/challenges/:id/pick',
  wrap(async (req, res) => {
    const challengeId = id(req.params.id),
      winner = req.body.winner;
    if (![1, 2].includes(winner)) fail('Choisissez un adversaire.');
    await db.$transaction(async (tx) => {
      const c = await tx.challenge.findUnique({ where: { id: challengeId } });
      if (!c) fail('Défi introuvable.', 404);
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${c.matchId} FOR UPDATE`;
      const match = await tx.match.findUnique({ where: { id: c.matchId } });
      if (
        !match ||
        match.isFinished ||
        new Date(c.closesAt) <= new Date() ||
        (match.startsAt && new Date(match.startsAt) <= new Date())
      )
        fail('Ce défi est clos.', 409);
      await tx.challengePick.upsert({
        where: { challengeId_userId: { challengeId, userId: req.user.userId } },
        create: { challengeId, userId: req.user.userId, winner },
        update: { winner },
      });
    });
    res.json({ success: true });
  }),
);
module.exports = router;
