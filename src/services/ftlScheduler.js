const { reportError } = require('../lib/report');
const { randomUUID } = require('node:crypto');
const { failure } = require('./ftlClient');
const events = require('./ftlEvents');
const { eventComplete, archiveCompleted } = require('./tournamentArchive');
const { configuration } = require('./ftlConfiguration');
const CONCURRENCY = 3;
const POOLS_INTERVAL = 30000,
  TABLEAU_INTERVAL = 10000;
const INTERVAL = 120000,
  LEASE = 180000,
  LEAD = 60000;
const enabled = () => process.env.FTL_AUTO_SYNC === 'true';

async function claim(db, competitionId, { automatic = false, now = new Date() } = {}) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
    const competition = await tx.competition.findUnique({ where: { id: competitionId } });
    if (!competition) throw failure('Épreuve introuvable.', 404);
    const tournament = await tx.tournament.findUnique({ where: { id: competition.tournamentId } });
    if (tournament?.archivedAt) throw failure('Tournoi archivé : suivi automatique arrêté.', 409);
    const state = await tx.ftlSyncState.upsert({ where: { competitionId }, create: { competitionId }, update: {} });
    if (state.leaseUntil > now)
      throw Object.assign(failure('Un contrôle de cette épreuve est déjà en cours.', 409), {
        retryAfter: Math.ceil((state.leaseUntil - now) / 1000),
      });
    const allowed = state.lastStartedAt ? state.lastStartedAt.getTime() + (automatic ? TABLEAU_INTERVAL : INTERVAL) : 0;
    if (now.getTime() < allowed)
      throw Object.assign(failure('Patientez deux minutes entre deux contrôles de cette épreuve.', 429), {
        retryAfter: Math.ceil((allowed - now) / 1000),
      });
    if (automatic && (!state.nextAutomaticAt || state.nextAutomaticAt > now)) return null;
    const token = randomUUID();
    await tx.ftlSyncState.update({
      where: { competitionId },
      data: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE), lastStartedAt: now, status: 'RUNNING' },
    });
    return { competition, token };
  });
}
async function finish(db, competitionId, token, summary, error = null, now = new Date()) {
  const state = await db.ftlSyncState.findUnique({ where: { competitionId } });
  if (state?.leaseToken !== token) return;
  // Épreuve terminée (podium officiel confirmé) : clôturée même si un avertissement persiste (ex. une poule
  // déjà finalisée que la source affiche désormais incohérente) ; seuls les vrais conflits de match la retiennent.
  const complete = Boolean(
    summary?.podium && !summary?.conflicts?.length && summary?.pools?.coverageComplete !== false,
  );
  const issues = !complete && (summary?.warnings?.length || summary?.conflicts?.length);
  const failures = error ? state.failures + 1 : 0;
  // Rythme lent (15 min) jusqu'au début des poules (heure FencingTimeLive, heure locale du lieu) ;
  // le dernier contrôle lent est calé 1 min avant, pour que la saisie reste ouverte sans à-coup.
  const start = summary?.eventStart ? Date.parse(summary.eventStart) : Date.parse(`${summary?.eventDate}T00:00:00Z`);
  const beforeEvent = start - LEAD > now.getTime();
  const openPools = summary?.openFirstResultPools > 0;
  const activeInterval =
    summary?.syncPhase === 'TABLEAU'
      ? TABLEAU_INTERVAL
      : summary?.syncPhase === 'POOLS' || openPools
        ? POOLS_INTERVAL
        : INTERVAL;
  const delay = error
    ? Math.min(30 * 60000, INTERVAL * 2 ** Math.min(failures - 1, 4))
    : beforeEvent
      ? Math.min(15 * 60000, start - LEAD - now.getTime())
      : issues && !openPools && summary?.syncPhase !== 'TABLEAU'
        ? 5 * 60000
        : activeInterval;
  await db.ftlSyncState.updateMany({
    where: { competitionId, leaseToken: token },
    data: {
      leaseToken: null,
      leaseUntil: null,
      lastFinishedAt: now,
      status: error ? 'ERROR' : complete ? 'COMPLETE' : issues ? 'ATTENTION' : 'READY',
      lastError: error || null,
      failures,
      nextAutomaticAt: complete ? null : new Date(now.getTime() + delay),
    },
  });
  // Alerte des administrateurs au 3e échec d'affilée, puis au rétablissement (sans bloquer le contrôle).
  await require('./syncHealth')
    .alertAdmins(db, { competitionId, failures, previousFailures: state.failures || 0, error })
    .catch(() => {});
  // Import bloqué sans panne pendant l'épreuve (avertissements répétés), puis rétablissement.
  if (!error && !complete)
    await require('./syncHealth')
      .alertAttention(db, {
        competitionId,
        previousStatus: state.status,
        warnings: [...(summary?.warnings || []), ...(summary?.conflicts || []).map((c) => c.message)],
        duringEvent: !beforeEvent,
      })
      .catch(() => {});
  // Site officiel figé en pleine épreuve (aucun nouveau résultat depuis longtemps) : alerte des administrateurs.
  if (!error && !beforeEvent)
    await require('./syncHealth')
      .alertStale(db, {
        competitionId,
        eventStart: summary?.eventStart,
        complete,
        timezone: summary?.timezone || 'Europe/Paris',
      })
      .catch(() => {});
  // Phase finale close faute d'horaire : alerte des administrateurs (une fois par match).
  if (!error)
    try {
      const competition = await db.competition.findUnique({
        where: { id: competitionId },
        select: { id: true, name: true, tournamentId: true },
      });
      if (competition) await require('./syncHealth').alertClosedWithoutTime(db, competition);
    } catch {
      /* alerte facultative */
    }
}
async function assertClaim(tx, competitionId, token) {
  const state = await tx.ftlSyncState.findUnique({ where: { competitionId } });
  if (state?.leaseToken !== token || state.leaseUntil <= new Date())
    throw failure('Contrôle expiré ou repris par un autre processus. Réessayez.', 409);
}
async function configFor(db, c) {
  const saved = await configuration(db, c.id);
  if (saved) return saved;
  const id = c.rosterSourceUrl?.match(/\/events\/competitors\/([a-f0-9]{32})$/i)?.[1]?.toUpperCase();
  return events[id] || null;
}
function windowDelay(config, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config?.date || '')) return null;
  // Begin preparing the day before; daily wakeups otherwise. Past unfinished events retry.
  const day = Date.parse(config.date + 'T00:00:00Z');
  return day - now > 86400000 ? Math.min(86400000, day - now - 86400000) : 0;
}
let running = false;
// Bilan du dernier passage pour le mode veille : contrôle en cours (busy) et prochaine échéance connue (nextAt).
let plan = { busy: true, nextAt: null };
async function tick(db, { sync, archive = archiveCompleted, now = new Date() } = {}) {
  if (running) return [];
  running = true;
  const outcomes = [];
  const upcoming = [];
  try {
    // Seules les épreuves dont le contrôle est dû sont relues (avec leurs matchs) : les autres attendent
    // leur heure sans coûter une lecture complète toutes les 30 s.
    const states = await db.ftlSyncState.findMany();
    for (const s of states) {
      const at = s.leaseUntil > now ? s.leaseUntil : s.nextAutomaticAt;
      if (at) upcoming.push(new Date(at).getTime());
    }
    const notDue = states
      .filter((s) => s.nextAutomaticAt === null || s.nextAutomaticAt > now || s.leaseUntil > now)
      .map((s) => s.competitionId);
    const competitions = await db.competition.findMany({
      where: {
        tournament: { archivedAt: null },
        OR: [{ rosterSourceUrl: { not: null } }, { ftlEventId: { not: null } }],
        ...(notDue.length ? { id: { notIn: notDue } } : {}),
      },
      include: { matches: true, pools: true, matchRounds: true },
      orderBy: { id: 'asc' },
    });
    const due = [];
    for (const c of competitions) {
      const state = states.find((s) => s.competitionId === c.id);
      if (
        eventComplete(c) &&
        !['RUNNING', 'ERROR', 'ATTENTION'].includes(state?.status) &&
        !(state?.leaseUntil > now)
      ) {
        if (state?.status !== 'COMPLETE' || state.nextAutomaticAt)
          await db.ftlSyncState.upsert({
            where: { competitionId: c.id },
            create: { competitionId: c.id, status: 'COMPLETE', nextAutomaticAt: null },
            update: { status: 'COMPLETE', nextAutomaticAt: null },
          });
        continue;
      }
      if (state && (state.nextAutomaticAt === null || state.nextAutomaticAt > now || state.leaseUntil > now)) continue;
      const config = await configFor(db, c);
      if (!config) continue;
      const delay = windowDelay(config, now.getTime());
      if (delay === null) continue;
      if (delay) {
        upcoming.push(now.getTime() + delay);
        await db.ftlSyncState.upsert({
          where: { competitionId: c.id },
          create: { competitionId: c.id, nextAutomaticAt: new Date(now.getTime() + delay), status: 'SCHEDULED' },
          update: { nextAutomaticAt: new Date(now.getTime() + delay), status: 'SCHEDULED' },
        });
        continue;
      }
      due.push(c);
    }
    // Plusieurs épreuves le même jour : contrôles en parallèle (3 à la fois), chacune garde son propre verrou.
    const runOne = async (c) => {
      try {
        // Actor 0 is the service, never a user's identity. Each event has its own claim/cooldown.
        const result = await (sync || require('./ftlSync').syncCompetition)(db, c.id, 0, undefined, {
          automatic: true,
        });
        return { competitionId: c.id, ok: true, created: result?.created || 0 };
      } catch (e) {
        return { competitionId: c.id, ok: false, status: e.status || 500 };
      }
    };
    let next = 0;
    const results = new Array(due.length);
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
        while (next < due.length) {
          const i = next++;
          results[i] = await runOne(due[i]);
        }
      }),
    );
    outcomes.push(...results);
    await archive(db, { now });
    const future = upcoming.filter((t) => t > now.getTime());
    plan = {
      busy: due.length > 0 || states.some((s) => s.status === 'RUNNING' || s.leaseUntil > now),
      nextAt: future.length ? Math.min(...future) : null,
    };
    if (due.length) require('../lib/idleClock').wakeAll(); // résultats importés : notifications à préparer
    return outcomes;
  } finally {
    running = false;
  }
}
// Délai avant le prochain passage : 5 s pendant un contrôle ; sinon jusqu'à la prochaine échéance connue, au plus
// le prochain créneau de veille (15 min). Sans mode veille : 5 s comme avant.
function nextDelay(now = Date.now(), current = plan) {
  const idle = require('../lib/idleClock');
  if (!idle.idleEnabled() || current.busy) return 5000;
  const slot = idle.untilSlot(0, now);
  return current.nextAt ? Math.min(slot, Math.max(5000, current.nextAt - now)) : slot;
}
function startWorker(db) {
  if (!enabled()) {
    console.warn('Suivi FencingTimeLive automatique désactivé (FTL_AUTO_SYNC ≠ true).');
    return () => {};
  }
  console.log('Suivi FencingTimeLive automatique actif (contrôle des échéances toutes les 5 s, veille hors épreuve).');
  let current = null,
    timer = null,
    stopped = false,
    again = false;
  const schedule = (delay) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  function run() {
    timer = null;
    current = tick(db)
      .then(async () => {
        require('../lib/heartbeat').beat('ftl', nextDelay());
        await require('./ftlEventDiscovery').watch(db);
      })
      .catch((error) => {
        console.warn('Contrôles automatiques temporairement indisponibles.');
        reportError(error, 'tâche FencingTimeLive');
      })
      .finally(() => {
        current = null;
        if (again) {
          again = false;
          schedule(1000);
        } else schedule(nextDelay());
      });
    return current;
  }
  // Réveil (action d'administration…) : passage dans la seconde, sans attendre la fin de la veille.
  const unregister = require('../lib/idleClock').registerWake('ftl', () => {
    if (stopped) return;
    if (current) again = true;
    else schedule(1000);
  });
  run();
  // Arrêt : plus de nouveau passage ; renvoie le passage en cours pour que l'arrêt l'attende
  // (le verrou de l'épreuve est ainsi libéré proprement avant un redéploiement).
  return () => {
    stopped = true;
    clearTimeout(timer);
    unregister();
    return current;
  };
}
module.exports = {
  enabled,
  claim,
  finish,
  assertClaim,
  configFor,
  windowDelay,
  tick,
  nextDelay,
  startWorker,
  INTERVAL,
  POOLS_INTERVAL,
  TABLEAU_INTERVAL,
};
