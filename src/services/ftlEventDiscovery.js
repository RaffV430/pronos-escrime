const { createClient, failure } = require('./ftlClient');
const { parseSchedule, scheduleUrl } = require('./ftlTournament');
const { configuration } = require('./ftlConfiguration');
const PREFIX = 'ftl-discovery:';
const INTERVAL = 3600000;
let running = false,
  nextPoll = 0;
const keyFor = (id) => PREFIX + id;
async function locked(db, tournamentId, fn) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
    const key = keyFor(tournamentId);
    const row = await tx.appSetting.findUnique({ where: { key } });
    const state = row?.value || { events: {} };
    const result = await fn(state, tx);
    await tx.appSetting.upsert({ where: { key }, create: { key, value: state }, update: { value: state } });
    return result;
  });
}
function reconcile(state, events, linked, now) {
  const fresh = [];
  for (const e of Object.values(state.events)) e.present = false;
  for (const e of events) {
    let stored = state.events[e.eventId];
    if (!stored) {
      stored = state.events[e.eventId] = {
        ...e,
        status: linked.has(e.eventId) ? 'ADDED' : 'PENDING',
        delivery: { pending: true },
        detectedAt: now.toISOString(),
      };
      if (stored.status === 'PENDING') fresh.push(e.eventId);
    }
    Object.assign(stored, e, { present: true });
    if (linked.has(e.eventId)) stored.status = 'ADDED';
  }
  state.lastCheckedAt = now.toISOString();
  state.lastError = null;
  return fresh;
}
async function scan(
  db,
  tournament,
  config,
  client,
  now = new Date(),
  notify = require('./syncHealth').notifyAdmins,
  manual = false,
) {
  const claimed = await locked(db, tournament.id, (state) => {
    if (Date.parse(state.leaseUntil) > now.getTime()) {
      if (manual) throw failure('Un contrôle est déjà en cours pour ce tournoi.', 409);
      return false;
    }
    if (!manual && Date.parse(state.nextCheckAt) > now.getTime()) {
      nextPoll = Math.min(nextPoll || Infinity, Date.parse(state.nextCheckAt));
      return false;
    }
    state.leaseUntil = new Date(now.getTime() + 180000).toISOString();
    state.tournamentId = tournament.id;
    state.tournamentName = tournament.name;
    state.sourceUrl = tournament.ftlSourceUrl;
    if (!manual || !state.nextCheckAt) state.nextCheckAt = new Date(now.getTime() + INTERVAL).toISOString();
    return true;
  });
  if (!claimed) return;
  try {
    const sourceUrl = scheduleUrl(tournament.ftlSourceUrl);
    await client.login();
    const parsed = parseSchedule(await client.get(sourceUrl), sourceUrl, config.timezone, config.city, {
      allowUnknownTime: true,
    });
    const linked = new Set(
      tournament.competitions
        .map((c) => c.ftlEventId)
        .filter(Boolean)
        .map((s) => s.toUpperCase()),
    );
    const fresh = await locked(db, tournament.id, async (state, tx) => {
      if (!state.initialized) {
        const previous = await tx.auditLog.findFirst({
          where: {
            action: 'Aperçu tournoi FTL',
            targetType: 'FtlTournamentPreview',
            after: { path: ['sourceUrl'], equals: sourceUrl },
          },
          orderBy: { id: 'desc' },
        });
        const baseline = previous?.after?.events || parsed.events;
        for (const e of baseline)
          if (/^[A-F0-9]{32}$/i.test(e.eventId || ''))
            state.events[e.eventId.toUpperCase()] = { eventId: e.eventId.toUpperCase(), status: 'KNOWN' };
        state.initialized = true;
      }
      const ids = reconcile(state, parsed.events, linked, now);
      state.tournamentId = tournament.id;
      state.tournamentName = tournament.name;
      state.sourceUrl = sourceUrl;
      for (const id of ids)
        await tx.auditLog.create({
          data: {
            actorId: 0,
            action: 'NOUVELLE_EPREUVE_FTL_DETECTEE',
            targetType: 'Tournament',
            targetId: tournament.id,
            after: { eventId: id, event: state.events[id].event, date: state.events[id].date },
          },
        });
      return ids.map((id) => state.events[id]);
    });
    // Persist discovery before sending: parallel workers and restarts never send it twice.
    for (const e of fresh) {
      let delivery;
      try {
        delivery = await notify(db, {
          title: 'Nouvelle épreuve FTL à vérifier',
          body: `${tournament.name} : ${e.event} · ${e.date} ${e.time || 'horaire non publié'} (${e.timezone}). À ajouter ou ignorer dans l’administration.`,
          tag: `ftl-new-${tournament.id}-${e.eventId}`,
          url: '/admin?panel=tournaments',
        });
      } catch {
        delivery = { uncertain: true };
      }
      await locked(db, tournament.id, (state) => {
        state.events[e.eventId].delivery = delivery;
      });
    }
  } catch (error) {
    await locked(db, tournament.id, (state) => {
      state.lastError = error.status ? error.message : 'Calendrier FTL temporairement illisible.';
    });
    if (manual) throw error;
  } finally {
    await locked(db, tournament.id, (state) => {
      state.leaseUntil = null;
    });
  }
}
async function watch(db, { now = new Date(), client = createClient(), notify, force = false } = {}) {
  if (running || (!force && nextPoll > now.getTime())) return;
  running = true;
  nextPoll = now.getTime() + INTERVAL;
  try {
    const tournaments = await db.tournament.findMany({
      where: { archivedAt: null, ftlSourceUrl: { not: null } },
      select: { id: true, name: true, ftlSourceUrl: true, competitions: { select: { id: true, ftlEventId: true } } },
    });
    for (const t of tournaments) {
      const configs = [];
      for (const c of t.competitions) {
        const current = await configuration(db, c.id);
        if (current) {
          configs.push(current);
          c.ftlEventId ||= current.eventId;
        }
      }
      const config = configs.find((c) => c.timezone);
      if (!config?.timezone) continue;
      const dates = configs
        .flatMap((c) => (c.scheduleSessions?.length ? c.scheduleSessions : [c]))
        .map((s) => Date.parse(s.date + 'T00:00:00Z'))
        .filter(Number.isFinite);
      if (
        !dates.length ||
        now.getTime() < Math.min(...dates) - 7 * 86400000 ||
        now.getTime() > Math.max(...dates) + 7 * 86400000
      )
        continue;
      await scan(db, t, config, client, now, notify);
    }
  } finally {
    running = false;
  }
}
async function list(db) {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: PREFIX } } });
  const linked = new Set(
    (await db.competition.findMany({ where: { ftlEventId: { not: null } }, select: { ftlEventId: true } })).map((c) =>
      c.ftlEventId.toUpperCase(),
    ),
  );
  const tournaments = await db.tournament.findMany({
    where: { archivedAt: null, ftlSourceUrl: { not: null } },
    select: { id: true, name: true, ftlSourceUrl: true },
  });
  return tournaments.map((t) => {
    const state = rows.find((r) => r.key === keyFor(t.id))?.value || {};
    return {
      tournamentId: t.id,
      name: t.name,
      sourceUrl: t.ftlSourceUrl,
      lastCheckedAt: state.lastCheckedAt,
      nextCheckAt: state.nextCheckAt,
      error: state.lastError,
      events: Object.values(state.events || {}).filter((e) => e.status === 'PENDING' && !linked.has(e.eventId)),
    };
  });
}
async function dismiss(db, tournamentId, eventId, actorId) {
  return locked(db, tournamentId, async (state, tx) => {
    const event = state.events[eventId];
    if (!event || event.status !== 'PENDING') throw failure('Épreuve à vérifier introuvable.', 404);
    event.status = 'DISMISSED';
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'EPREUVE_FTL_IGNOREE',
        targetType: 'Tournament',
        targetId: tournamentId,
        after: { eventId, event: event.event },
      },
    });
    return { ignored: true };
  });
}
async function checkNow(db, tournamentId, client = createClient(), notify) {
  const t = await db.tournament.findUnique({ where: { id: tournamentId }, include: { competitions: true } });
  if (!t || t.archivedAt || !t.ftlSourceUrl) throw failure('Tournoi FTL suivi introuvable.', 404);
  let config;
  for (const c of t.competitions) {
    const current = await configuration(db, c.id);
    c.ftlEventId ||= current?.eventId;
    if (!config && current?.timezone) config = current;
  }
  if (!config?.timezone) throw failure('Configurez le fuseau d’une épreuve de ce tournoi.', 409);
  await scan(
    db,
    t,
    config,
    client,
    new Date(),
    notify || (process.env.FTL_AUTO_SYNC === 'true' ? undefined : async () => ({ mail: 0, push: 0, disabled: true })),
    true,
  );
  return { checked: true };
}
module.exports = { checkNow, watch, scan, reconcile, list, dismiss, INTERVAL, PREFIX };
