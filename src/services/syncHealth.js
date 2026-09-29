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
    checkedAt: new Date(now).toISOString(),
    summary: {
      error: rows.filter((r) => r.level === 'error').length,
      warning: rows.filter((r) => r.level === 'warning').length,
      ok: rows.filter((r) => r.level === 'ok').length,
    },
    competitions: rows,
  };
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
    const admins = await db.user.findMany({ where: { isAdmin: true }, select: { id: true, email: true, name: true } });
    const sent = { mail: 0, push: 0 };
    const mailer = deps.mailer || require('./mailer');
    if (mailer.mailConfigured())
      for (const admin of admins) {
        try {
          await mailer.sendMail({ to: admin.email, subject: title, text: body, html: `<p>${body}</p>` });
          sent.mail++;
        } catch (e) {
          reportError(e, 'alerte administrateur (e-mail)');
        }
      }
    const push = deps.push || require('./pushNotifications');
    if (push.configured()) {
      const subs = await db.pushSubscription.findMany({
        where: { enabled: true, userId: { in: admins.map((a) => a.id) } },
      });
      for (const sub of subs) {
        try {
          await push.send(sub, { title, body, tag: `ftl-${competitionId}`, url: '/?admin=sync' }, 3600);
          sent.push++;
        } catch (e) {
          reportError(e, 'alerte administrateur (notification)');
        }
      }
    }
    if (crossed)
      reportError(new Error(`${title} : ${error || 'erreur inconnue'}`), 'suivi FencingTimeLive', { competitionId });
    return { kind: crossed ? 'down' : 'recovered', ...sent };
  } catch (e) {
    reportError(e, 'alerte administrateur');
    return null;
  }
}

module.exports = { health, syncHealth, alertAdmins, ALERT_AFTER };
