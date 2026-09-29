const { reportError } = require('../lib/report');
const { randomUUID } = require('node:crypto');
const { failure } = require('./ftlClient');
const events = require('./ftlEvents');
const { eventComplete, archiveCompleted } = require('./tournamentArchive');
const { configuration } = require('./ftlConfiguration');
const CONCURRENCY = 3;
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
    const allowed = state.lastStartedAt ? state.lastStartedAt.getTime() + INTERVAL : 0;
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
  const issues = summary?.warnings?.length || summary?.conflicts?.length;
  const complete = Boolean(summary?.podium && !issues);
  const failures = error ? state.failures + 1 : 0;
  // Rythme lent (15 min) jusqu'au début des poules (heure FencingTimeLive, heure locale du lieu) ;
  // le dernier contrôle lent est calé 1 min avant, pour que la saisie reste ouverte sans à-coup.
  const start = summary?.eventStart ? Date.parse(summary.eventStart) : Date.parse(`${summary?.eventDate}T00:00:00Z`);
  const beforeEvent = start - LEAD > now.getTime();
  const openPools = summary?.openFirstResultPools > 0;
  const delay = error
    ? Math.min(30 * 60000, INTERVAL * 2 ** Math.min(failures - 1, 4))
    : beforeEvent
      ? Math.min(15 * 60000, start - LEAD - now.getTime())
      : issues && !openPools
        ? 5 * 60000
        : INTERVAL;
  await db.ftlSyncState.updateMany({
    where: { competitionId, leaseToken: token },
    data: {
      leaseToken: null,
      leaseUntil: null,
      lastFinishedAt: now,
      status: error ? 'ERROR' : issues ? 'ATTENTION' : complete ? 'COMPLETE' : 'READY',
      lastError: error || null,
      failures,
      nextAutomaticAt: complete ? null : new Date(now.getTime() + delay),
    },
  });
  // Alerte des administrateurs au 3e échec d'affilée, puis au rétablissement (sans bloquer le contrôle).
  await require('./syncHealth')
    .alertAdmins(db, { competitionId, failures, previousFailures: state.failures || 0, error })
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
async function tick(db, { sync, archive = archiveCompleted, now = new Date() } = {}) {
  if (running) return [];
  running = true;
  const outcomes = [];
  try {
    // Seules les épreuves dont le contrôle est dû sont relues (avec leurs matchs) : les autres attendent
    // leur heure sans coûter une lecture complète toutes les 30 s.
    const states = await db.ftlSyncState.findMany();
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
    return outcomes;
  } finally {
    running = false;
  }
}
function startWorker(db) {
  if (!enabled()) {
    console.warn('Suivi FencingTimeLive automatique désactivé (FTL_AUTO_SYNC ≠ true).');
    return () => {};
  }
  console.log('Suivi FencingTimeLive automatique actif (contrôle toutes les 30 s).');
  let current = null;
  const run = () =>
    (current = tick(db)
      .then(() => require('../lib/heartbeat').beat('ftl'))
      .catch((error) => {
        console.warn('Contrôles automatiques temporairement indisponibles.');
        reportError(error, 'tâche FencingTimeLive');
      }));
  const timer = setInterval(run, 30000);
  timer.unref();
  run();
  // Arrêt : plus de nouveau passage ; renvoie le passage en cours pour que l'arrêt l'attende
  // (le verrou de l'épreuve est ainsi libéré proprement avant un redéploiement).
  return () => {
    clearInterval(timer);
    return current;
  };
}
module.exports = { enabled, claim, finish, assertClaim, configFor, windowDelay, tick, startWorker, INTERVAL };
