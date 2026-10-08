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
const groups = require('../services/groups');
const { enroll } = groups;
// Début d'un tournoi (premier match ou première poule) : moment où la composition des clubs est figée.
async function startOf(tournamentId) {
  if (!tournamentId) return null;
  const t = await db.tournament.findUnique({
    where: { id: tournamentId },
    include: { competitions: { select: { id: true } } },
  });
  if (!t) fail('Tournoi introuvable.', 404);
  return require('../services/club').tournamentStart(db, t);
}
// Tournoi demandé (?tournamentId=) ou toute la saison.
const scopeOf = (req) => (req.query.tournamentId ? id(req.query.tournamentId) : null);
const isMember = (league, userId) => league.members.some((m) => m.userId === userId && !m.leftAt);
async function leagueFor(leagueId, userId) {
  const league = await db.league.findUnique({ where: { id: leagueId }, include: { members: true } });
  if (!league || league.archivedAt || !isMember(league, userId)) fail('Ce groupe est privé.', 403);
  return league;
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
// Préférence personnelle ; une délégation quittée n'est jamais sélectionnée implicitement.
router.get(
  '/favorite',
  wrap(async (req, res) => {
    const user = await db.user.findUnique({ where: { id: req.user.userId }, select: { favoriteLeagueId: true } });
    const league = user?.favoriteLeagueId
      ? await db.league.findFirst({
          where: {
            id: user.favoriteLeagueId,
            archivedAt: null,
            members: { some: { userId: req.user.userId, leftAt: null } },
          },
          select: { id: true },
        })
      : null;
    res.json({ leagueId: league?.id || null });
  }),
);
router.put(
  '/favorite',
  wrap(async (req, res) => {
    const leagueId = req.body.leagueId === null ? null : id(req.body.leagueId);
    if (
      leagueId &&
      !(await db.league.findFirst({
        where: { id: leagueId, archivedAt: null, members: { some: { userId: req.user.userId, leftAt: null } } },
        select: { id: true },
      }))
    )
      fail('Cette délégation ne fait pas partie de vos adhésions.', 403);
    await db.user.update({ where: { id: req.user.userId }, data: { favoriteLeagueId: leagueId } });
    res.json({ leagueId });
  }),
);
// Club de l'application : tireurs mis en avant et ligue du club de chaque tournoi (créée automatiquement).
let clubCheckedAt = 0;
router.get(
  '/club',
  wrap(async (req, res) => {
    const club = require('../services/club');
    if (Date.now() - clubCheckedAt > 5 * 60000) {
      clubCheckedAt = Date.now();
      await groups.ensureAppClub(db).catch((e) => reportError(e, 'ligue du club'));
    }
    const { name, fencers } = await club.getClub(db);
    const league = name ? await groups.ensureAppClub(db) : null;
    const member = league
      ? await db.leagueMember.findFirst({ where: { leagueId: league.id, userId: req.user.userId, leftAt: null } })
      : null;
    res.json({ name, fencers, league: league ? { leagueId: league.id, member: Boolean(member) } : null });
  }),
);
// Rejoindre le club de l'application en un clic (l'ancienne adresse par tournoi reste acceptée).
router.post(
  ['/club/join', '/club/:tournamentId/join'],
  wrap(async (req, res) => {
    const league = await groups.ensureAppClub(db);
    if (!league) fail('Pas de club configuré.', 404);
    await db.$transaction((tx) => enroll(tx, league, req.user.userId));
    res.json({ leagueId: league.id, message: `Bienvenue dans le club « ${league.name} ».` });
  }),
);
router.get(
  '/leagues',
  wrap(async (req, res) =>
    res.json(
      await db.league.findMany({
        where: { archivedAt: null, members: { some: { userId: req.user.userId, leftAt: null } } },
        include: { _count: { select: { members: { where: { leftAt: null } } } } },
        orderBy: { id: 'desc' },
      }),
    ),
  ),
);
router.post(
  '/leagues',
  wrap(async (req, res) => {
    const name = title(req.body.name),
      kind = req.body.kind;
    if (!['PRIVATE', 'CLUB'].includes(kind)) fail('Type de groupe invalide.');
    const result = await db.$transaction(async (tx) => {
      const league = await tx.league.create({
        data: {
          name,
          kind,
          tournamentId: null,
          startsAt: new Date(),
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
    if (!league) fail('Groupe introuvable.', 404);
    if (league.ownerId === req.user.userId) fail('Le créateur reste membre de son groupe.');
    await groups.leave(db, league, req.user.userId);
    res.json({ success: true });
  }),
);
// Duel match par match sur les matchs terminés uniquement : aucun pronostic n'est dévoilé avant la fin d'un match.
async function duel(userId, opponentId, competition) {
  const matches = await db.match.findMany({
    where: {
      isFinished: true,
      OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }],
      ...(competition ? { competition } : {}),
    },
    include: { competition: { select: { name: true } } },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  const ids = matches.map((m) => m.id);
  const finished = competition ? { competition } : {};
  const [pools, podiums] = await Promise.all([
    db.pool.findMany({
      where: { isFinal: true, ...finished },
      select: { id: true, name: true, competition: { select: { name: true } }, fencers: { select: { id: true } } },
      orderBy: [{ startsAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    }),
    db.competition
      .findMany({ where: competition || {}, select: { id: true, name: true, officialPodium: true } })
      .then((list) => list.filter((c) => c.officialPodium?.gold)),
  ]);
  const fencerIds = pools.flatMap((p) => p.fencers.map((f) => f.id));
  const podiumIds = podiums.map((c) => c.id);
  const predictions = (who) =>
    Promise.all([
      db.prediction.findMany({ where: { userId: who, matchId: { in: ids } } }),
      db.poolPrediction.findMany({ where: { userId: who, fencerId: { in: fencerIds } } }),
      db.podiumPrediction.findMany({ where: { userId: who, competitionId: { in: podiumIds } } }),
    ]);
  const [[mine, poolMine, podiumMine], [theirs, poolTheirs, podiumTheirs], opponent] = await Promise.all([
    predictions(userId),
    predictions(opponentId),
    db.user.findUnique({ where: { id: opponentId }, select: { id: true, name: true } }),
  ]);
  return {
    opponent,
    ...buildDuel(matches, mine, theirs, { pools, poolMine, poolTheirs, podiums, podiumMine, podiumTheirs }),
  };
}
// Duel depuis les Classements, avec n'importe quel joueur classé : épreuve, tournoi ou toute la saison.
router.get(
  '/duel/:opponentId',
  wrap(async (req, res) => {
    const opponentId = id(req.params.opponentId);
    if (opponentId === req.user.userId) fail('Choisissez un autre joueur.');
    if (!(await db.user.findUnique({ where: { id: opponentId }, select: { id: true } })))
      fail('Joueur introuvable.', 404);
    const competition = req.query.competitionId
      ? { id: id(req.query.competitionId) }
      : req.query.tournamentId
        ? { tournamentId: id(req.query.tournamentId) }
        : null;
    res.json(await duel(req.user.userId, opponentId, competition));
  }),
);
router.get(
  '/leagues/:id/duel/:opponentId',
  wrap(async (req, res) => {
    const league = await leagueFor(id(req.params.id), req.user.userId);
    const opponentId = id(req.params.opponentId);
    if (opponentId === req.user.userId || !isMember(league, opponentId))
      fail('Choisissez un autre membre du groupe.', 404);
    const tournamentId = scopeOf(req);
    res.json({
      league: { id: league.id, name: league.name },
      ...(await duel(req.user.userId, opponentId, tournamentId ? { tournamentId } : null)),
    });
  }),
);
// Classement d'un groupe ou d'un club : sur un tournoi (?tournamentId=) ou sur toute la saison.
router.get(
  '/leagues/:id',
  wrap(async (req, res) => {
    const league = await leagueFor(id(req.params.id), req.user.userId);
    const tournamentId = scopeOf(req);
    const start = await startOf(tournamentId);
    const counted = groups.membersFor(league, { start, tournamentId });
    const rows = await standings(db, tournamentId ? { tournamentId } : {});
    res.json({
      league: { ...league, members: undefined, memberCount: league.members.filter(groups.active).length },
      tournamentId,
      ranking: rankRows(rows.filter((r) => counted.some((m) => m.userId === r.id))),
    });
  }),
);
router.get(
  '/clubs/:tournamentId',
  wrap(async (req, res) => {
    const tournamentId = id(req.params.tournamentId);
    const [rows, start, leagues] = await Promise.all([
      standings(db, { tournamentId }),
      startOf(tournamentId),
      db.league.findMany({ where: { kind: 'CLUB', archivedAt: null }, include: { members: true } }),
    ]);
    res.json(
      rankRows(
        leagues
          .map((l) => {
            const members = groups.clubMembersAt(l.members, start);
            return {
              id: l.id,
              name: l.name,
              members: members.length,
              eligible: members.length >= 3,
              totalPoints: clubScore(members, rows),
            };
          })
          .filter((l) => l.eligible),
      ),
    );
  }),
);
router.get(
  '/challenges',
  wrap(async (req, res) => {
    const where = req.query.competitionId
      ? { competitionId: id(req.query.competitionId) }
      : req.query.tournamentId
        ? { competition: { tournamentId: id(req.query.tournamentId) } }
        : {};
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
