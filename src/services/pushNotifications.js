const { reportError } = require('../lib/report');
const { roundLabel, matchNotificationText } = require('./notificationText');
const webpush = require('web-push');
const { preferences, isQuiet, roundSummaries } = require('./playerExperience');
const { failure } = require('./ftlClient');
const { timedMatches } = require('./roundTiming');
const { matchClosed, closesAt } = require('../lib/matchLock');
function configured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}
function validateSubscription(input) {
  let url;
  try {
    url = new URL(input?.endpoint);
  } catch {
    throw failure('Abonnement aux notifications invalide.', 400);
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.href.length > 2048 ||
    !(
      host === 'fcm.googleapis.com' ||
      host === 'updates.push.services.mozilla.com' ||
      host.endsWith('.push.services.mozilla.com') ||
      host === 'web.push.apple.com' ||
      host.endsWith('.notify.windows.com')
    )
  )
    throw failure('Service de notifications non reconnu.', 400);
  for (const [key, size] of [
    ['p256dh', 65],
    ['auth', 16],
  ])
    if (
      typeof input.keys?.[key] !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(input.keys[key]) ||
      Buffer.from(input.keys[key], 'base64url').length !== size
    )
      throw failure('Clé d’abonnement invalide.', 400);
  if (Buffer.from(input.keys.p256dh, 'base64url')[0] !== 4) throw failure('Clé de navigateur invalide.', 400);
  return { endpoint: url.href, p256dh: input.keys.p256dh, auth: input.keys.auth };
}
function validateScopes(input) {
  const result = {};
  for (const key of ['tournamentIds', 'competitionIds']) {
    const values = input[key] || [];
    if (!Array.isArray(values) || values.length > 128 || values.some((v) => !Number.isSafeInteger(v) || v < 1))
      throw failure('Sélection de notifications invalide.', 400);
    result[key] = [...new Set(values)];
  }
  if (!result.tournamentIds.length && !result.competitionIds.length)
    throw failure('Choisissez au moins un tournoi ou une épreuve.', 400);
  return result;
}
async function subscribe(db, userId, input) {
  const subscription = validateSubscription(input.subscription),
    scopes = validateScopes(input),
    prefs = preferences(input.preferences);
  const [t, c] = await Promise.all([
    db.tournament.count({ where: { id: { in: scopes.tournamentIds } } }),
    db.competition.count({ where: { id: { in: scopes.competitionIds } } }),
  ]);
  if (t !== scopes.tournamentIds.length || c !== scopes.competitionIds.length)
    throw failure('Une compétition sélectionnée n’existe plus.', 409);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184725)`;
    const current = await tx.pushSubscription.findUnique({ where: { endpoint: subscription.endpoint } });
    if (current && current.userId !== userId)
      throw failure('Cet appareil est associé à un autre compte. Réinitialisez son abonnement.', 409);
    if (!current && (await tx.pushSubscription.count({ where: { userId, enabled: true } })) >= 10)
      throw failure('Dix appareils sont déjà activés. Désactivez un ancien appareil.', 409);
    const changed =
      JSON.stringify(current?.preferences) !== JSON.stringify(prefs) ||
      !current?.enabled ||
      JSON.stringify(current.tournamentIds) !== JSON.stringify(scopes.tournamentIds) ||
      JSON.stringify(current.competitionIds) !== JSON.stringify(scopes.competitionIds);
    const latest = changed ? await tx.pushEvent.findFirst({ orderBy: { id: 'desc' } }) : null;
    if (current && changed)
      await tx.pushDelivery.updateMany({
        where: { subscriptionId: current.id, status: { in: ['PENDING', 'SENDING'] } },
        data: { status: 'CANCELLED' },
      });
    const row = await tx.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: { ...subscription, ...scopes, preferences: prefs, userId, lastEventId: latest?.id || 0 },
      update: {
        ...subscription,
        ...scopes,
        preferences: prefs,
        enabled: true,
        ...(changed ? { lastEventId: latest?.id || 0, preferencesSince: new Date() } : {}),
      },
    });
    return { id: row.id, enabled: row.enabled, preferences: prefs, ...scopes };
  });
}
function follows(sub, c) {
  return sub.tournamentIds.includes(c.tournamentId) || sub.competitionIds.includes(c.id);
}
async function queueForSubscription(db, id) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184725)`;
      await tx.$queryRaw`SELECT id FROM "PushSubscription" WHERE id=${id} FOR UPDATE`;
      const sub = await tx.pushSubscription.findUnique({ where: { id } });
      if (!sub?.enabled) return;
      const events = await tx.pushEvent.findMany({
        where: { id: { gt: sub.lastEventId } },
        orderBy: { id: 'asc' },
        take: 500,
      });
      if (!events.length) return;
      const throughEventId = events.at(-1).id;
      // Event cursor retained for compatibility; round policy queues notifications below.
      await tx.pushSubscription.update({ where: { id }, data: { lastEventId: throughEventId } });
    },
    { timeout: 15000 },
  );
}
function payload(c, matches, id) {
  return {
    title: `${matches.length} nouveau${matches.length > 1 ? 'x' : ''} match${matches.length > 1 ? 's' : ''} à pronostiquer`,
    body: c.name,
    tag: `pronos-${id}`,
    url: `/?tournament=${c.tournamentId}&event=${c.id}&new=1&matches=${matches
      .slice(0, 64)
      .map((m) => m.id)
      .join(',')}`,
  };
}
// Priorité « high » pour ce qui est urgent (clôture proche, réouverture, alerte administrateur) :
// en « normal », iOS peut retarder la livraison jusqu'au réveil de l'appareil.
const URGENT = new Set(['AVAILABLE', 'REMINDER', 'REOPENED', 'POOLS', 'MATCHES']);
async function send(subscription, content, ttl, urgency = 'normal') {
  return webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
    JSON.stringify(content),
    {
      TTL: ttl,
      timeout: 7000,
      urgency: urgency === 'high' ? 'high' : 'normal',
      vapidDetails: {
        subject: process.env.VAPID_SUBJECT,
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
      },
    },
  );
}
async function deliver(db, id, sender = send) {
  const delivery = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PushDelivery" WHERE id=${id} FOR UPDATE`;
    const row = await tx.pushDelivery.findUnique({ where: { id }, include: { subscription: true } });
    if (!row || row.status !== 'PENDING' || row.nextAttemptAt > Date.now()) return null;
    await tx.pushDelivery.update({
      where: { id },
      data: { status: 'SENDING', claimedAt: new Date(), attempts: { increment: 1 } },
    });
    return row;
  });
  if (!delivery) return;
  const sub = await db.pushSubscription.findUnique({ where: { id: delivery.subscriptionId } }),
    c = await db.competition.findUnique({ where: { id: delivery.competitionId } });
  const matches = c ? await timedMatches(db, await db.match.findMany({ where: { competitionId: c.id } })) : [];
  const open = matches.filter((m) => delivery.matchIds.includes(m.id) && !matchClosed(m));
  if ((delivery.kind || 'MATCHES') !== 'MATCHES') return deliverSpecial(db, delivery, sub, c, matches, sender);
  if (
    !sub?.enabled ||
    !preferences(sub.preferences || {}).newMatches ||
    !c ||
    !follows(sub, c) ||
    !open.length ||
    Date.now() - delivery.createdAt.getTime() > 900000
  ) {
    await db.pushDelivery.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'CANCELLED' } });
    return;
  }
  if (isQuiet(sub.preferences)) {
    await db.pushDelivery.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'CANCELLED' } });
    return;
  }
  const deadlines = open.map(closesAt).filter(Boolean).map(Date.parse);
  const ttl = Math.max(1, Math.min(900, ...deadlines.map((d) => Math.floor((d - Date.now()) / 1000))));
  try {
    await sender(sub, payload(c, open, id), ttl, 'high');
    await db.pushDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } catch (e) {
    if ([404, 410].includes(e.statusCode))
      await db.pushSubscription.update({ where: { id: sub.id }, data: { enabled: false } });
    const retry = ![400, 401, 403, 404, 410].includes(e.statusCode) && delivery.attempts < 3;
    await db.pushDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: retry ? 'PENDING' : 'FAILED',
        nextAttemptAt: new Date(Date.now() + 60000 * 2 ** delivery.attempts),
      },
    });
  }
}

function roundAlertPlan(matches, round, now = Date.now()) {
  const open = matches.filter(
    (m) =>
      m.round === round.round &&
      m.resultType !== 'CANCELLED' &&
      m.player1?.trim() &&
      m.player2?.trim() &&
      !matchClosed(m, now),
  );
  const missing = open.filter((m) => !m.predictions?.length);
  const urgent = missing.filter(
    (m) => closesAt(m) && Date.parse(closesAt(m)) > now && Date.parse(closesAt(m)) - now <= 600000,
  );
  return {
    threshold:
      Number.isSafeInteger(round.expectedMatchCount) &&
      round.expectedMatchCount > 0 &&
      open.length >= Math.ceil(round.expectedMatchCount / 2),
    missing,
    urgent,
  };
}
// Contexte commun à tous les abonnements pour un passage de la tâche : épreuves des tournois non
// archivés, leurs matchs (sans pronostics) et leurs tours, lus une seule fois au lieu d'une fois par abonné.
async function notificationContext(db) {
  const competitions = await db.competition.findMany({ where: { tournament: { archivedAt: null } } });
  const ids = competitions.map((c) => c.id);
  const [matches, rounds, pools, reopenings] = await Promise.all([
    ids.length ? db.match.findMany({ where: { competitionId: { in: ids } } }) : [],
    ids.length ? db.matchRound.findMany({ where: { competitionId: { in: ids } } }) : [],
    ids.length && db.pool
      ? db.pool.findMany({
          where: { competitionId: { in: ids } },
          select: { id: true, competitionId: true, isFinal: true, fencers: { select: { firstResultAt: true } } },
        })
      : [],
    // Horaires publiés après une clôture par défaut (2 dernières heures).
    ids.length && db.auditLog
      ? db.auditLog.findMany({
          where: {
            action: require('./ftlSync').REOPEN_ACTION,
            targetType: 'Match',
            createdAt: { gte: new Date(Date.now() - 2 * 3600e3) },
          },
          select: { targetId: true, after: true },
        })
      : [],
  ]);
  const timed = await timedMatches({ matchRound: { findMany: async () => rounds } }, matches);
  return competitions.map((c) => ({
    competition: c,
    matches: timed.filter((m) => m.competitionId === c.id),
    rounds: rounds.filter((r) => r.competitionId === c.id),
    pools: (pools || []).filter((p) => p.competitionId === c.id),
    reopened: (reopenings || []).filter((r) => r.after?.competitionId === c.id).map((r) => r.targetId),
  }));
}
// Toutes les poules de l'épreuve sont publiées : date du dernier blocage connu (approximation de la fin).
function poolsFinishedAt(pools = []) {
  if (!pools.length || pools.some((p) => !p.isFinal)) return null;
  const stamps = pools.flatMap((p) => (p.fencers || []).map((f) => f.firstResultAt)).filter(Boolean);
  return stamps.length ? Math.max(...stamps.map((d) => new Date(d).getTime())) : null;
}
const poolResultsText = (points, fencers) =>
  `Poules terminées · ${points} point${points > 1 ? 's' : ''} (${fencers} tireur${fencers > 1 ? 's' : ''} pronostiqué${fencers > 1 ? 's' : ''})`;
const reopenedText = (round, start, timezone = 'Europe/Paris') =>
  `${roundLabel(round)} · horaire publié : pronostics rouverts jusqu’à ${new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(start))}`;
const recapText = (r) =>
  `Épreuve terminée · ${r.points} point${r.points > 1 ? 's' : ''}` +
  (r.rank ? ` · ${r.rank === 1 ? '1er' : `${r.rank}e`} sur ${r.players}` : '') +
  ' · votre récap est prêt';
async function queueSpecial(db, id, context = null) {
  const shared = context || (await notificationContext(db));
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PushSubscription" WHERE id=${id} FOR UPDATE`;
      const sub = await tx.pushSubscription.findUnique({ where: { id } });
      if (!sub?.enabled) return;
      const p = preferences(sub.preferences || {});
      if ((!p.newMatches && !p.reminders && !p.roundResults && !p.poolResults) || isQuiet(p)) return;
      // Bilan des poules (au choix du joueur) : une notification par épreuve, poules toutes publiées,
      // seulement s'il y a pronostiqué et si elles ont fini après l'activation de l'option (24 h au plus).
      if (p.poolResults) {
        const since = Math.max(Date.now() - 86400000, new Date(sub.preferencesSince || sub.createdAt).getTime());
        for (const x of shared.filter((y) => follows(sub, y.competition))) {
          const finished = poolsFinishedAt(x.pools);
          if (!finished || finished < since) continue;
          const played = await tx.poolPrediction.count({
            where: { userId: sub.userId, fencer: { pool: { competitionId: x.competition.id } } },
          });
          if (!played) continue;
          await tx.pushDelivery.upsert({
            where: {
              subscriptionId_competitionId_throughEventId_kind_round: {
                subscriptionId: id,
                competitionId: x.competition.id,
                throughEventId: 0,
                kind: 'POOLRESULTS',
                round: 'pools',
              },
            },
            create: {
              subscriptionId: id,
              competitionId: x.competition.id,
              throughEventId: 0,
              kind: 'POOLRESULTS',
              round: 'pools',
              matchIds: [],
            },
            update: {},
          });
        }
      }
      // Récap de fin d'épreuve : pour les joueurs qui ont demandé leurs bilans (tours ou poules),
      // une fois le podium officiel publié, s'ils ont pronostiqué dans l'épreuve.
      if (p.roundResults || p.poolResults) {
        const since = Math.max(Date.now() - 86400000, new Date(sub.preferencesSince || sub.createdAt).getTime());
        for (const x of shared.filter((y) => follows(sub, y.competition))) {
          const ended = x.competition.podiumResolvedAt && new Date(x.competition.podiumResolvedAt).getTime();
          if (!ended || ended < since) continue;
          const cid = x.competition.id;
          const [a, b, c] = await Promise.all([
            tx.prediction.count({ where: { userId: sub.userId, match: { competitionId: cid } } }),
            tx.poolPrediction.count({ where: { userId: sub.userId, fencer: { pool: { competitionId: cid } } } }),
            tx.podiumPrediction.count({ where: { userId: sub.userId, competitionId: cid } }),
          ]);
          if (!a && !b && !c) continue;
          await tx.pushDelivery.upsert({
            where: {
              subscriptionId_competitionId_throughEventId_kind_round: {
                subscriptionId: id,
                competitionId: cid,
                throughEventId: 0,
                kind: 'RECAP',
                round: 'recap',
              },
            },
            create: {
              subscriptionId: id,
              competitionId: cid,
              throughEventId: 0,
              kind: 'RECAP',
              round: 'recap',
              matchIds: [],
            },
            update: {},
          });
        }
      }
      // Horaire publié après la clôture par défaut : pronostics rouverts, une alerte par match.
      if (p.newMatches)
        for (const x of shared.filter((y) => follows(sub, y.competition)))
          for (const matchId of x.reopened || [])
            await tx.pushDelivery.upsert({
              where: {
                subscriptionId_competitionId_throughEventId_kind_round: {
                  subscriptionId: id,
                  competitionId: x.competition.id,
                  throughEventId: 0,
                  kind: 'REOPENED',
                  round: `match-${matchId}`,
                },
              },
              create: {
                subscriptionId: id,
                competitionId: x.competition.id,
                throughEventId: 0,
                kind: 'REOPENED',
                round: `match-${matchId}`,
                matchIds: [matchId],
              },
              update: {},
            });
      if (!p.newMatches && !p.reminders && !p.roundResults) return;
      const followed = shared.filter((x) => follows(sub, x.competition) && x.matches.length);
      if (!followed.length) return;
      // Pronostics de ce joueur sur les matchs suivis, en une seule requête.
      const saved = await tx.prediction.findMany({
        where: { userId: sub.userId, matchId: { in: followed.flatMap((x) => x.matches.map((m) => m.id)) } },
      });
      const byMatch = new Map();
      for (const s of saved) byMatch.set(s.matchId, [...(byMatch.get(s.matchId) || []), s]);
      for (const { competition: c, matches: timed, rounds } of followed) {
        const matches = timed.map((m) => ({ ...m, predictions: byMatch.get(m.id) || [] }));
        const recaps = roundSummaries(matches, rounds);
        for (const round of rounds) {
          const plan = roundAlertPlan(matches, round);
          const missing = plan.urgent;
          // A reminder replaces a threshold alert queued in the same window.
          if (p.reminders && missing.length) {
            await tx.pushDelivery.updateMany({
              where: {
                subscriptionId: id,
                competitionId: c.id,
                round: round.round,
                kind: 'AVAILABLE',
                status: 'PENDING',
              },
              data: { status: 'CANCELLED' },
            });
            await tx.pushDelivery.upsert({
              where: {
                subscriptionId_competitionId_throughEventId_kind_round: {
                  subscriptionId: id,
                  competitionId: c.id,
                  throughEventId: 0,
                  kind: 'AVAILABLE',
                  round: round.round,
                },
              },
              create: {
                subscriptionId: id,
                competitionId: c.id,
                throughEventId: 0,
                kind: 'AVAILABLE',
                round: round.round,
                matchIds: [],
                status: 'CANCELLED',
              },
              update: {},
            });
          }
          const recap = recaps.find((r) => r.round === round.round);
          const recent =
            recap?.completedAt &&
            Date.parse(recap.completedAt) >=
              Math.max(Date.now() - 86400000, new Date(sub.preferencesSince || sub.createdAt).getTime());
          for (const [kind, active, ids] of [
            [
              'AVAILABLE',
              p.newMatches && plan.threshold && plan.missing.length && !(p.reminders && missing.length),
              plan.missing.map((m) => m.id),
            ],
            ['REMINDER', p.reminders && missing.length, missing.map((m) => m.id)],
            ['ROUND', p.roundResults && recap?.completed && recap.saved > 0 && recent, []],
          ]) {
            if (!active) continue;
            await tx.pushDelivery.upsert({
              where: {
                subscriptionId_competitionId_throughEventId_kind_round: {
                  subscriptionId: id,
                  competitionId: c.id,
                  throughEventId: 0,
                  kind,
                  round: round.round,
                },
              },
              create: {
                subscriptionId: id,
                competitionId: c.id,
                throughEventId: 0,
                kind,
                round: round.round,
                matchIds: ids,
              },
              update: {},
            });
          }
        }
      }
    },
    { timeout: 20000 },
  );
}
async function deliverSpecial(db, delivery, sub, c, matches, sender) {
  const { id, kind, round } = delivery;
  const cancel = () => db.pushDelivery.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'CANCELLED' } });
  // Alerte personnelle (tireur de son podium hors tableau) : envoyée même sans suivre l'épreuve.
  if (!sub?.enabled || !c || (kind !== 'PODIUM_OUT' && !follows(sub, c))) return cancel();
  if (kind === 'PODIUM_OUT') {
    const m = /^podium-out-([A-Z]+)-(.+)$/.exec(round || '');
    const { podiumClosed } = require('../lib/matchLock');
    if (!m || c.podiumResolvedAt || podiumClosed(c, await db.match.findMany({ where: { competitionId: c.id } })))
      return cancel();
    const competition = await db.competition.findUnique({ where: { id: c.id }, select: { podiumRoster: true } });
    const entry = (competition?.podiumRoster || []).find((e) => e.id === m[2]);
    const { podiumOutNotification, REASONS } = require('./podiumAlerts');
    try {
      await sender(sub, { ...podiumOutNotification(c, entry, REASONS[m[1]]), tag: `pronos-${id}` }, 6 * 3600, 'high');
      await db.pushDelivery.updateMany({
        where: { id, status: 'SENDING' },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (e) {
      if ([404, 410].includes(e.statusCode))
        await db.pushSubscription.update({ where: { id: sub.id }, data: { enabled: false } });
      await db.pushDelivery.updateMany({
        where: { id, status: 'SENDING' },
        data: {
          status: delivery.attempts < 3 && ![400, 401, 403, 404, 410].includes(e.statusCode) ? 'PENDING' : 'FAILED',
          nextAttemptAt: new Date(Date.now() + 60000 * 2 ** delivery.attempts),
        },
      });
    }
    return;
  }
  const prefs = preferences(sub.preferences || {});
  // Une recomposition annoncée pendant les heures calmes attend leur fin plutôt que d'être perdue.
  // Poules modifiées juste avant leur début (France) : notification prioritaire, sans attendre ni filtre.
  const urgentPools = kind === 'POOLS' && String(round || '').startsWith('pools-urgent-');
  if (
    !urgentPools &&
    kind === 'POOLS' &&
    prefs.newMatches &&
    isQuiet(prefs) &&
    Date.now() - delivery.createdAt.getTime() < 86400000
  )
    return db.pushDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: { status: 'PENDING', attempts: { decrement: 1 }, nextAttemptAt: new Date(Date.now() + 15 * 60000) },
    });
  if (
    (!urgentPools && isQuiet(prefs)) ||
    (!urgentPools && kind === 'POOLS' && !prefs.newMatches) ||
    (kind === 'AVAILABLE' && !prefs.newMatches) ||
    (kind === 'REMINDER' && !prefs.reminders) ||
    (kind === 'ROUND' && !prefs.roundResults) ||
    (kind === 'POOLRESULTS' && !prefs.poolResults) ||
    (kind === 'RECAP' && !prefs.roundResults && !prefs.poolResults) ||
    (kind === 'REOPENED' && !prefs.newMatches)
  )
    return cancel();
  let content, ttl;
  if (kind === 'AVAILABLE') {
    const rounds = await db.matchRound.findMany({ where: { competitionId: c.id } }),
      manifest = rounds.find((r) => r.round === round);
    if (!manifest) return cancel();
    const predictions = await db.prediction.findMany({
        where: { userId: sub.userId, matchId: { in: matches.map((m) => m.id) } },
        select: { matchId: true },
      }),
      saved = new Set(predictions.map((p) => p.matchId));
    const plan = roundAlertPlan(
      matches.map((m) => ({ ...m, predictions: saved.has(m.id) ? [{}] : [] })),
      manifest,
    );
    if (!plan.threshold || !plan.missing.length || Date.now() - delivery.createdAt.getTime() > 900000) return cancel();
    // If delayed into the reminder window, leave it to the reminder queue.
    if (prefs.reminders && plan.urgent.length) return cancel();
    const deadlines = plan.missing.map(closesAt).filter(Boolean).map(Date.parse);
    ttl = Math.max(1, Math.min(900, ...deadlines.map((d) => Math.floor((d - Date.now()) / 1000))));
    content = { ...payload(c, plan.missing, id), ...matchNotificationText(c, round, plan.missing, prefs.timezone) };
  } else if (kind === 'REMINDER') {
    const predictions = await db.prediction.findMany({
        where: { userId: sub.userId, matchId: { in: matches.map((m) => m.id) } },
        select: { matchId: true },
      }),
      saved = new Set(predictions.map((p) => p.matchId));
    const missing = matches.filter(
      (m) =>
        m.round === round &&
        !saved.has(m.id) &&
        !matchClosed(m) &&
        closesAt(m) &&
        Date.parse(closesAt(m)) - Date.now() <= 600000,
    );
    if (!missing.length || Date.now() - delivery.createdAt.getTime() > 900000) return cancel();
    ttl = Math.max(1, Math.min(900, ...missing.map((m) => Math.floor((Date.parse(closesAt(m)) - Date.now()) / 1000))));
    content = {
      ...matchNotificationText(c, round, missing, prefs.timezone, 'REMINDER'),
      tag: `pronos-${id}`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&new=1&matches=${missing
        .slice(0, 64)
        .map((m) => m.id)
        .join(',')}`,
    };
  } else if (kind === 'ROUND') {
    if (Date.now() - delivery.createdAt.getTime() > 86400000) return cancel();
    const raw = await db.match.findMany({
        where: { competitionId: c.id },
        include: { predictions: { where: { userId: sub.userId } } },
      }),
      rounds = await db.matchRound.findMany({ where: { competitionId: c.id } });
    const recap = roundSummaries(raw, rounds).find((r) => r.round === round);
    if (!recap?.completed || !recap.saved) return cancel();
    ttl = 3600;
    content = {
      title: c.name,
      body: `${roundLabel(round)} · tour terminé · ${recap.total} match${recap.total > 1 ? 's' : ''} · ${recap.points} point${recap.points > 1 ? 's' : ''}`,
      tag: `pronos-${id}`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&view=mine`,
    };
  } else if (kind === 'REOPENED') {
    const matchId = delivery.matchIds[0];
    const raw = await db.match.findMany({ where: { competitionId: c.id } });
    const m = (await timedMatches(db, raw)).find((x) => x.id === matchId);
    const start = m?.startsAt ? new Date(m.startsAt).getTime() : NaN;
    if (!m || matchClosed(m) || !(start - Date.now() > 5 * 60000)) return cancel();
    const own = await db.prediction.count({ where: { userId: sub.userId, matchId } });
    if (own) return cancel();
    ttl = Math.max(60, Math.min(3600, Math.floor((start - Date.now()) / 1000)));
    content = {
      title: c.name,
      body: reopenedText(m.round, start, prefs.timezone),
      tag: `pronos-${id}`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&matches=${matchId}`,
    };
  } else if (kind === 'RECAP') {
    if (Date.now() - delivery.createdAt.getTime() > 86400000) return cancel();
    const competition = await db.competition.findUnique({
      where: { id: c.id },
      include: { tournament: { select: { name: true } } },
    });
    const recap = await require('../routes/personalRoutes').competitionRecap(competition, sub.userId);
    if (!recap.predictions) return cancel();
    ttl = 3600;
    content = {
      title: c.name,
      body: recapText(recap),
      tag: `pronos-${id}`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&view=mine`,
    };
  } else if (kind === 'POOLRESULTS') {
    if (Date.now() - delivery.createdAt.getTime() > 86400000) return cancel();
    const rows = await db.poolPrediction.findMany({
      where: { userId: sub.userId, fencer: { pool: { competitionId: c.id, isFinal: true } } },
      select: { pointsEarned: true },
    });
    if (!rows.length) return cancel();
    const points = rows.reduce((n, r) => n + (r.pointsEarned || 0), 0);
    ttl = 3600;
    content = {
      title: c.name,
      body: poolResultsText(points, rows.length),
      tag: `pronos-${id}`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&view=mine`,
    };
  } else if (kind === 'POOLS') {
    // Poules recomposées sur FencingTimeLive : prévenir tant que les poules concernées restent ouvertes.
    if (Date.now() - delivery.createdAt.getTime() > 86400000) return cancel();
    const pools = await db.pool.findMany({
      where: { id: { in: delivery.matchIds }, competitionId: c.id, isLocked: false, isFinal: false },
      select: { name: true, startsAt: true },
    });
    if (delivery.matchIds.length && !pools.length) return cancel();
    ttl = 3600;
    content = {
      ...require('./poolRecompose').poolsNotification(c, pools, { urgent: urgentPools }),
      tag: `pronos-${id}`,
    };
  } else return cancel();
  try {
    await sender(sub, content, ttl, URGENT.has(kind) ? 'high' : 'normal');
    await db.pushDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } catch (e) {
    if ([404, 410].includes(e.statusCode))
      await db.pushSubscription.update({ where: { id: sub.id }, data: { enabled: false } });
    const retry = ![400, 401, 403, 404, 410].includes(e.statusCode) && delivery.attempts < 3;
    await db.pushDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: retry ? 'PENDING' : 'FAILED',
        nextAttemptAt: new Date(Date.now() + 60000 * 2 ** delivery.attempts),
      },
    });
  }
}
let running = false;
async function retireLegacy(db) {
  // Remember already announced rounds before retiring per-import alerts.
  await db.$executeRaw`INSERT INTO "PushDelivery" (id,"subscriptionId","competitionId","throughEventId",kind,round,"matchIds",status,attempts,"nextAttemptAt","createdAt","sentAt")
 SELECT gen_random_uuid()::text,d."subscriptionId",d."competitionId",0,'AVAILABLE',m.round,ARRAY[]::integer[],'SENT',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,MAX(d."sentAt")
 FROM "PushDelivery" d JOIN "Match" m ON m.id=ANY(d."matchIds") AND m."competitionId"=d."competitionId"
 WHERE d.kind='MATCHES' AND d.status='SENT'
 GROUP BY d."subscriptionId",d."competitionId",m.round
 ON CONFLICT ("subscriptionId","competitionId","throughEventId",kind,round) DO NOTHING`;
  await db.pushDelivery.updateMany({
    where: { kind: 'MATCHES', status: { in: ['PENDING', 'SENDING'] } },
    data: { status: 'CANCELLED' },
  });
}
let legacyRetired = false;
async function dispatch(db, sender = send) {
  if (running) return;
  running = true;
  try {
    // Ancien format d'alertes : conversion une seule fois par démarrage (jointure coûteuse).
    if (!legacyRetired) {
      await retireLegacy(db);
      legacyRetired = true;
    }
    // Resume interrupted sends with the same notification tag, never a new event.
    await db.pushDelivery.updateMany({
      where: { status: 'SENDING', claimedAt: { lt: new Date(Date.now() - 120000) } },
      data: { status: 'PENDING' },
    });
    const subs = await db.pushSubscription.findMany({ where: { enabled: true }, select: { id: true } });
    const context = subs.length ? await notificationContext(db) : [];
    for (const sub of subs) {
      await queueForSubscription(db, sub.id);
      await queueSpecial(db, sub.id, context);
    }
    const pending = await db.pushDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    let index = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (index < pending.length) {
          const item = pending[index++];
          try {
            await deliver(db, item.id, sender);
          } catch (error) {
            console.warn('Envoi de notification à réessayer.');
            reportError(error, 'envoi de notification');
          }
        }
      }),
    );
  } finally {
    running = false;
  }
}
function startWorker(db) {
  if (!configured()) {
    console.warn('Notifications désactivées : clés VAPID absentes.');
    return () => {};
  }
  console.log('Notifications actives (envoi toutes les 30 s).');
  let current = null;
  const tick = () =>
    (current = dispatch(db)
      .then(() => require('../lib/heartbeat').beat('push'))
      .catch((error) => {
        console.warn('Notifications temporairement indisponibles.');
        reportError(error, 'tâche des notifications');
      }));
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
  return () => {
    clearInterval(timer);
    return current;
  };
}
module.exports = {
  notificationContext,
  poolsFinishedAt,
  poolResultsText,
  recapText,
  reopenedText,
  retireLegacy,
  roundAlertPlan,
  queueSpecial,
  deliverSpecial,
  configured,
  validateSubscription,
  validateScopes,
  subscribe,
  follows,
  queueForSubscription,
  payload,
  deliver,
  dispatch,
  startWorker,
  send,
};
