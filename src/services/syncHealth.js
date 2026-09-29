// État du suivi automatique FencingTimeLive, pour l'administration, et alertes aux administrateurs
// quand une épreuve n'est plus contrôlée (3 échecs d'affilée), puis quand le suivi est rétabli.
const { reportError } = require('../lib/report');

const ALERT_AFTER = 3; // échecs consécutifs
const LATE_MS = 10 * 60000; // contrôle prévu dépassé de plus de 10 min

function health(state, competition, now = Date.now()) {
  const next = state?.nextAutomaticAt ? new Date(state.nextAutomaticAt).getTime() : null;
  const late = next !== null && now - next > LATE_MS && state?.status !== 'COMPLETE';
  const level = !state
    ? 'waiting'
    : state.status === 'ERROR' || state.failures >= ALERT_AFTER
      ? 'error'
      : state.status === 'ATTENTION' || late
        ? 'warning'
        : 'ok';
  return {
    competitionId: competition.id,
    competition: competition.name,
    tournament: competition.tournament?.name || null,
    status: state?.status || 'PENDING',
    level,
    late,
    failures: state?.failures || 0,
    lastError: state?.lastError || null,
    lastFinishedAt: state?.lastFinishedAt || null,
    nextAutomaticAt: state?.nextAutomaticAt || null,
  };
}

async function syncHealth(db, now = Date.now()) {
  const competitions = await db.competition.findMany({
    where: {
      tournament: { archivedAt: null },
      OR: [{ rosterSourceUrl: { not: null } }, { ftlEventId: { not: null } }],
    },
    select: { id: true, name: true, tournament: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
  const states = await db.ftlSyncState.findMany({ where: { competitionId: { in: competitions.map((c) => c.id) } } });
  const rows = competitions.map((c) =>
    health(
      states.find((s) => s.competitionId === c.id),
      c,
      now,
    ),
  );
  return {
    workerEnabled: process.env.FTL_AUTO_SYNC === 'true',
    // Canaux d'alerte des administrateurs : sans e-mail, seules les notifications arrivent.
    mailConfigured: require('./mailer').mailConfigured(),
    pushConfigured: require('./pushNotifications').configured(),
    checkedAt: new Date(now).toISOString(),
    summary: {
      error: rows.filter((r) => r.level === 'error').length,
      warning: rows.filter((r) => r.level === 'warning').length,
      ok: rows.filter((r) => r.level === 'ok').length,
    },
    competitions: rows,
  };
}

// E-mail (si configuré) et notification à chaque administrateur ; un échec d'envoi n'interrompt rien.
async function notifyAdmins(db, { title, body, tag, url }, deps = {}) {
  const admins = await db.user.findMany({ where: { isAdmin: true }, select: { id: true, email: true, name: true } });
  const sent = { mail: 0, push: 0, mailFailed: 0, pushFailed: 0, mailConfigured: false, pushConfigured: false };
  const mailer = deps.mailer || require('./mailer');
  sent.mailConfigured = mailer.mailConfigured();
  if (sent.mailConfigured)
    for (const admin of admins) {
      try {
        await mailer.sendMail({ to: admin.email, subject: title, text: body, html: `<p>${body}</p>` });
        sent.mail++;
      } catch (e) {
        sent.mailFailed++;
        reportError(e, 'alerte administrateur (e-mail)');
      }
    }
  const push = deps.push || require('./pushNotifications');
  sent.pushConfigured = push.configured();
  if (sent.pushConfigured) {
    const subs = await db.pushSubscription.findMany({
      where: { enabled: true, userId: { in: admins.map((a) => a.id) } },
    });
    for (const sub of subs) {
      try {
        await push.send(sub, { title, body, tag, url }, 3600, 'high');
        sent.push++;
      } catch (e) {
        sent.pushFailed++;
        reportError(e, 'alerte administrateur (notification)');
      }
    }
  }
  return sent;
}

// Résultat d'une alerte dans le journal d'administration (envois réussis ou échoués, canaux actifs).
async function logResult(db, entry, result) {
  try {
    if (entry?.id) await db.auditLog.update({ where: { id: entry.id }, data: { after: result } });
  } catch {
    /* journal facultatif */
  }
  return result;
}

// Demi-finale, petite finale ou finale close par la règle par défaut (10 min après le tour précédent)
// faute d'horaire FencingTimeLive : alerte des administrateurs, une fois par match.
const NO_TIME_ACTION = 'Alerte clôture sans horaire';
const NO_TIME_ROUNDS = { T4: 'Demi-finale', Bronze: 'Petite finale', T2: 'Finale' };
function closedWithoutTime(timed, now = Date.now()) {
  const { matchClosed } = require('../lib/matchLock');
  return timed.filter(
    (m) =>
      NO_TIME_ROUNDS[m.round] &&
      !m.startsAt &&
      !m.isFinished &&
      !m.isLocked &&
      !m.syncIssue &&
      !m.manualUnlockUntil &&
      m.resultType !== 'CANCELLED' &&
      m.previousRoundCompletedAt &&
      m.player1?.trim() &&
      m.player2?.trim() &&
      matchClosed(m, now),
  );
}
async function alertClosedWithoutTime(db, competition, deps = {}) {
  try {
    const raw = await db.match.findMany({ where: { competitionId: competition.id } });
    const found = closedWithoutTime(await require('./roundTiming').timedMatches(db, raw), deps.now);
    if (!found.length) return [];
    const done = await db.auditLog.findMany({
      where: { action: NO_TIME_ACTION, targetType: 'Match', targetId: { in: found.map((m) => m.id) } },
      select: { targetId: true },
    });
    const alerted = [];
    for (const m of found.filter((x) => !done.some((d) => d.targetId === x.id))) {
      // Journal d'abord : jamais deux alertes pour le même match, même si l'envoi échoue.
      const entry = await db.auditLog.create({
        data: { actorId: 0, action: NO_TIME_ACTION, targetType: 'Match', targetId: m.id },
      });
      const label = NO_TIME_ROUNDS[m.round];
      const at = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(new Date(m.previousRoundCompletedAt).getTime() + 10 * 60000));
      await notifyAdmins(
        db,
        {
          title: `${label} close sans horaire · ${competition.name}`,
          body: `${m.player1} / ${m.player2} : pronostics clos à ${at} (10 minutes après le tour précédent), FencingTimeLive n'a pas publié d'heure. La saisie rouvrira d'elle-même si l'heure est publiée ; sinon, réouverture manuelle possible dans l'administration du tableau.`,
          tag: `no-time-${m.id}`,
          url: `/?tournament=${competition.tournamentId}&event=${competition.id}&matches=${m.id}`,
        },
        deps,
      ).then((result) => logResult(db, entry, result));
      alerted.push(m.id);
    }
    return alerted;
  } catch (e) {
    reportError(e, 'alerte clôture sans horaire');
    return [];
  }
}

// Appelé après chaque contrôle. N'alerte qu'au passage du seuil (pas à chaque échec) et au rétablissement.
async function alertAdmins(db, { competitionId, failures, previousFailures, error }, deps = {}) {
  const crossed = failures === ALERT_AFTER;
  const recovered = failures === 0 && previousFailures >= ALERT_AFTER;
  if (!crossed && !recovered) return null;
  try {
    const competition = await db.competition.findUnique({ where: { id: competitionId }, select: { name: true } });
    const name = competition?.name || `épreuve ${competitionId}`;
    const title = crossed ? `Suivi FencingTimeLive en panne · ${name}` : `Suivi FencingTimeLive rétabli · ${name}`;
    const body = crossed
      ? `${ALERT_AFTER} contrôles d'affilée ont échoué (${error || 'erreur inconnue'}). Les pronostics de poules se bloquent tant que la lecture échoue. Voir Administration → Suivi.`
      : 'Les contrôles automatiques fonctionnent de nouveau.';
    const sent = await notifyAdmins(db, { title, body, tag: `ftl-${competitionId}`, url: '/?admin=sync' }, deps);
    await db.auditLog
      ?.create({
        data: {
          actorId: 0,
          action: crossed ? 'Alerte suivi FTL en panne' : 'Alerte suivi FTL rétabli',
          targetType: 'Competition',
          targetId: competitionId,
          after: sent,
        },
      })
      ?.catch(() => {});
    if (crossed)
      reportError(new Error(`${title} : ${error || 'erreur inconnue'}`), 'suivi FencingTimeLive', { competitionId });
    return { kind: crossed ? 'down' : 'recovered', ...sent };
  } catch (e) {
    reportError(e, 'alerte administrateur');
    return null;
  }
}

module.exports = {
  health,
  syncHealth,
  alertAdmins,
  notifyAdmins,
  closedWithoutTime,
  alertClosedWithoutTime,
  ALERT_AFTER,
  NO_TIME_ACTION,
};
