// Tableau d'animation pour l'administrateur : participation au tournoi, joueurs sans pronostic,
// et relance en un clic (notification aux joueurs qui ont des matchs ouverts non pronostiqués).
const { matchClosed } = require('../lib/matchLock');
const { timedMatches } = require('./roundTiming');
const { failure } = require('./ftlClient');
const { reportError } = require('../lib/report');

const REMIND_EVERY = 30 * 60000; // une relance par épreuve toutes les 30 min au plus
const REMIND_ACTION = 'Relance des joueurs';

async function engagement(db, tournamentId, now = Date.now()) {
  const tournament = await db.tournament.findUnique({
    where: { id: tournamentId },
    include: { competitions: { select: { id: true, name: true } } },
  });
  if (!tournament) throw failure('Tournoi introuvable.', 404);
  const ids = tournament.competitions.map((c) => c.id);
  const [users, matchRows, poolRows, podiumRows, rawMatches] = await Promise.all([
    db.user.findMany({ select: { id: true, name: true, createdAt: true } }),
    db.prediction.findMany({
      where: { match: { competitionId: { in: ids } } },
      select: { userId: true, createdAt: true, match: { select: { competitionId: true } } },
    }),
    db.poolPrediction.findMany({
      where: { fencer: { pool: { competitionId: { in: ids } } } },
      select: { userId: true, updatedAt: true, fencer: { select: { pool: { select: { competitionId: true } } } } },
    }),
    db.podiumPrediction.findMany({
      where: { competitionId: { in: ids } },
      select: { userId: true, competitionId: true },
    }),
    db.match.findMany({ where: { competitionId: { in: ids } } }),
  ]);
  const matches = await timedMatches(db, rawMatches);
  const open = matches.filter(
    (m) => m.player1?.trim() && m.player2?.trim() && m.resultType !== 'CANCELLED' && !matchClosed(m, now),
  );
  const active = new Map(); // userId → dernière activité
  const touch = (userId, at) => {
    const t = at ? new Date(at).getTime() : 0;
    active.set(userId, Math.max(active.get(userId) || 0, t));
  };
  for (const p of matchRows) touch(p.userId, p.createdAt);
  for (const p of poolRows) touch(p.userId, p.updatedAt);
  for (const p of podiumRows) touch(p.userId, null);
  const perCompetition = tournament.competitions.map((c) => {
    const players = new Set([
      ...matchRows.filter((p) => p.match.competitionId === c.id).map((p) => p.userId),
      ...poolRows.filter((p) => p.fencer.pool.competitionId === c.id).map((p) => p.userId),
      ...podiumRows.filter((p) => p.competitionId === c.id).map((p) => p.userId),
    ]);
    const openHere = open.filter((m) => m.competitionId === c.id);
    return {
      id: c.id,
      name: c.name,
      players: players.size,
      predictions: matchRows.filter((p) => p.match.competitionId === c.id).length,
      openMatches: openHere.length,
    };
  });
  const inactive = users
    .filter((u) => !active.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, since: u.createdAt }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return {
    tournament: { id: tournament.id, name: tournament.name },
    users: users.length,
    activePlayers: active.size,
    participation: users.length ? Math.round((active.size * 100) / users.length) : 0,
    competitions: perCompetition,
    inactive,
  };
}

// Relance : notification aux abonnés qui suivent l'épreuve et n'ont pas pronostiqué tous ses matchs ouverts.
async function remind(db, competitionId, actorId, deps = {}) {
  const push = deps.push || require('./pushNotifications');
  if (!push.configured()) throw failure('Notifications non configurées sur le serveur (clés VAPID).', 409);
  const last = await db.auditLog.findFirst({
    where: { action: REMIND_ACTION, targetType: 'Competition', targetId: competitionId },
    orderBy: { id: 'desc' },
  });
  const now = deps.now || Date.now();
  if (last && now - new Date(last.createdAt).getTime() < REMIND_EVERY)
    throw failure('Une relance a déjà été envoyée il y a moins de 30 minutes pour cette épreuve.', 429);
  const competition = await db.competition.findUnique({ where: { id: competitionId } });
  if (!competition) throw failure('Épreuve introuvable.', 404);
  const matches = await timedMatches(db, await db.match.findMany({ where: { competitionId } }));
  const open = matches.filter(
    (m) => m.player1?.trim() && m.player2?.trim() && m.resultType !== 'CANCELLED' && !matchClosed(m, now),
  );
  if (!open.length) throw failure('Aucun match ouvert à pronostiquer dans cette épreuve.', 409);
  const subs = await db.pushSubscription.findMany({
    where: {
      enabled: true,
      OR: [{ tournamentIds: { has: competition.tournamentId } }, { competitionIds: { has: competition.id } }],
    },
  });
  const saved = await db.prediction.findMany({
    where: { matchId: { in: open.map((m) => m.id) } },
    select: { userId: true, matchId: true },
  });
  let sent = 0;
  const players = new Set();
  for (const sub of subs) {
    const missing = open.filter((m) => !saved.some((p) => p.userId === sub.userId && p.matchId === m.id));
    if (!missing.length) continue;
    try {
      await push.send(
        sub,
        {
          title: competition.name,
          body: `${missing.length} match${missing.length > 1 ? 's' : ''} à pronostiquer : c’est le moment !`,
          tag: `relance-${competition.id}`,
          url: `/?tournament=${competition.tournamentId}&event=${competition.id}&new=1`,
        },
        3600,
      );
      sent++;
      players.add(sub.userId);
    } catch (e) {
      if (![404, 410].includes(e.statusCode)) reportError(e, 'relance des joueurs');
    }
  }
  await db.auditLog.create({
    data: {
      actorId,
      action: REMIND_ACTION,
      targetType: 'Competition',
      targetId: competitionId,
      after: { sent, players: players.size },
    },
  });
  return { sent, players: players.size, openMatches: open.length };
}

module.exports = { engagement, remind };
