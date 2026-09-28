const { load } = require('cheerio');
const { createClient, ORIGIN } = require('./ftlClient');
const { parseSchedule, scheduleUrl } = require('./ftlTournament');
const { configuration } = require('./ftlConfiguration');
const { norm, clean } = require('./ftlParser');
// Stored results, points and predictions are never deleted by archiving.
const include = {
  competitions: {
    orderBy: { id: 'asc' },
    include: {
      matches: { orderBy: { id: 'asc' } },
      pools: { orderBy: { id: 'asc' } },
      matchRounds: { orderBy: { round: 'asc' } },
    },
  },
};
function eventComplete(c) {
  const matches = (c.matches || []).filter((m) => m.resultType !== 'CANCELLED');
  const podium = Boolean(
    c.podiumResolvedAt &&
    c.resultsVerifiedAt &&
    c.officialPodium?.finalConfirmed &&
    (c.podiumFormat !== 'TEAM' || c.officialPodium.bronzeMatchConfirmed),
  );
  if (!podium || !(c.pools || []).every((p) => p.isFinal)) return false;
  // Legacy podium-only events have no match imports to finish.
  if (!matches.length) return !(c.matchRounds || []).length;
  return (
    matches.every((m) => m.isFinished && !m.syncIssue) &&
    Boolean(c.matchRounds?.length) &&
    c.matchRounds.every((r) => matches.filter((m) => m.round === r.round).length === r.expectedMatchCount) &&
    matches.some((m) => m.round === 'T2') &&
    (c.podiumFormat !== 'TEAM' || matches.some((m) => m.round === 'Bronze'))
  );
}
function scheduleFinished(html, source, timezone) {
  const parsed = parseSchedule(html, source, timezone),
    $ = load(html);
  return {
    ...parsed,
    finished: parsed.events.every((e) => {
      const row = $('tr[id]').filter((_, r) => $(r).attr('id').toUpperCase() === `EV_${e.eventId}`);
      return row.length === 1 && /^Finished at \d{1,2}:\d{2}\s*(AM|PM)\b/i.test(clean(row.children('td').eq(2).text()));
    }),
  };
}
const signature = (t) =>
  JSON.stringify([
    t.ftlSourceUrl,
    t.competitions.map((c) => [
      c.id,
      c.name,
      c.ftlEventId,
      c.rosterSourceUrl,
      c.resultsVerifiedAt,
      c.podiumResolvedAt,
      c.officialPodium,
      c.matches.map((m) => [m.id, m.isFinished, m.syncIssue, m.resultType]),
      c.pools.map((p) => [p.id, p.isFinal]),
      c.matchRounds.map((r) => [r.id, r.round, r.expectedMatchCount]),
    ]),
  ]);
async function checkTournament(db, t, client = createClient(), now = new Date()) {
  if (t.archivedAt || !t.competitions.length || !t.competitions.every(eventComplete)) return false;
  const configs = await Promise.all(t.competitions.map((c) => configuration(db, c.id)));
  let source = t.ftlSourceUrl;
  await client.login();
  if (!source) {
    const roster = t.competitions.find((c) => c.rosterSourceUrl)?.rosterSourceUrl;
    if (!roster) return false;
    const $ = load(await client.get(roster));
    const links = [
      ...new Set(
        $('a[href]')
          .toArray()
          .map((a) => new URL($(a).attr('href'), ORIGIN).href)
          .filter((u) => /^https:\/\/www\.fencingtimelive\.com\/tournaments\/eventSchedule\/[a-f0-9]{32}$/i.test(u)),
      ),
    ];
    if (links.length !== 1) return false;
    source = links[0];
  }
  source = scheduleUrl(source);
  const observed = scheduleFinished(
    await client.get(source),
    source,
    configs.find((c) => c?.timezone)?.timezone || 'UTC',
  );
  if (!observed.finished) return false;
  for (let i = 0; i < t.competitions.length; i++) {
    const c = t.competitions[i];
    let cfg = configs[i] || require('./ftlEvents')[c.rosterSourceUrl?.split('/').at(-1)?.toUpperCase()];
    if (!cfg && c.rosterSourceUrl) {
      const $ = load(await client.get(c.rosterSourceUrl));
      const stamp = Date.parse(clean($('.desktop.eventTime').text()) + ' UTC');
      if (Number.isFinite(stamp))
        cfg = {
          event: clean($('.desktop.eventName').text()),
          tournament: clean($('.desktop.tournName').text()),
          date: new Date(stamp).toISOString().slice(0, 10),
        };
    }
    const id = c.ftlEventId || c.rosterSourceUrl?.split('/').at(-1)?.toUpperCase(),
      e = observed.events.find((e) => e.eventId === id);
    if (
      !cfg ||
      !e ||
      norm(e.event) !== norm(cfg.event) ||
      norm(observed.tournament) !== norm(cfg.tournament) ||
      e.date !== cfg.date
    )
      return false;
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${t.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE "tournamentId"=${t.id} ORDER BY id FOR UPDATE`;
    const fresh = await tx.tournament.findUnique({ where: { id: t.id }, include });
    if (!fresh || fresh.archivedAt || signature(fresh) !== signature(t) || !fresh.competitions.every(eventComplete))
      return false;
    const ids = fresh.competitions.map((c) => c.id);
    const states = await tx.ftlSyncState.findMany({ where: { competitionId: { in: ids } } });
    if (states.some((s) => s.status === 'RUNNING' || s.leaseUntil > now || ['ERROR', 'ATTENTION'].includes(s.status)))
      return false;
    await tx.tournament.update({
      where: { id: t.id },
      data: { archivedAt: now, completionNextCheckAt: null, ftlSourceUrl: source },
    });
    await tx.ftlSyncState.updateMany({
      where: { competitionId: { in: ids } },
      data: { status: 'COMPLETE', nextAutomaticAt: null },
    });
    await tx.auditLog.create({
      data: {
        actorId: 0,
        action: 'Tournoi archivé après vérification officielle',
        targetType: 'Tournament',
        targetId: t.id,
        after: {
          sourceUrl: source,
          checkedAt: now.toISOString(),
          events: observed.events.map((e) => ({ eventId: e.eventId, name: e.event, date: e.date })),
        },
      },
    });
    return true;
  });
}
async function archiveCompleted(db, { clientFactory = createClient, now = new Date() } = {}) {
  const tournaments = await db.tournament.findMany({
      where: { archivedAt: null, OR: [{ completionNextCheckAt: null }, { completionNextCheckAt: { lte: now } }] },
      include,
      orderBy: { id: 'asc' },
    }),
    archived = [];
  for (const t of tournaments) {
    if (!t.competitions.length || !t.competitions.every(eventComplete)) continue;
    // Atomic hour-long claim prevents duplicate checks by multiple server processes.
    const claim = await db.tournament.updateMany({
      where: {
        id: t.id,
        archivedAt: null,
        OR: [{ completionNextCheckAt: null }, { completionNextCheckAt: { lte: now } }],
      },
      data: { completionNextCheckAt: new Date(+now + 3600000) },
    });
    if (!claim.count) continue;
    try {
      if (await checkTournament(db, t, clientFactory(), now)) archived.push(t.id);
    } catch {
      console.warn(`Vérification de fin du tournoi ${t.id} à réessayer.`);
    }
  }
  return archived;
}
module.exports = { eventComplete, scheduleFinished, checkTournament, archiveCompleted };

// Archivage manuel depuis l'administration : même effet que l'archivage
// automatique (tournoi masqué de « Pronostiquer », suivi FencingTimeLive arrêté,
// résultats et pronostics conservés), sans attendre la vérification officielle.
async function archiveStatus(db, tournamentId) {
  const t = await db.tournament.findUnique({ where: { id: tournamentId }, include });
  if (!t) return null;
  const ids = t.competitions.map((c) => c.id);
  const states = ids.length ? await db.ftlSyncState.findMany({ where: { competitionId: { in: ids } } }) : [];
  const openMatches = t.competitions
    .flatMap((c) => c.matches)
    .filter((m) => !m.isFinished && m.resultType !== 'CANCELLED').length;
  return {
    id: t.id,
    name: t.name,
    archivedAt: t.archivedAt,
    competitions: t.competitions.map((c) => ({ id: c.id, name: c.name, complete: eventComplete(c) })),
    openMatches,
    running: states.some((s) => s.status === 'RUNNING'),
  };
}

async function archiveManually(db, tournamentId, actorId, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
    const status = await archiveStatus(tx, tournamentId);
    if (!status) throw Object.assign(new Error('Tournoi introuvable.'), { status: 404 });
    if (status.archivedAt) throw Object.assign(new Error('Ce tournoi est déjà archivé.'), { status: 409 });
    if (status.running)
      throw Object.assign(new Error('Un contrôle FencingTimeLive est en cours. Réessayez dans quelques minutes.'), {
        status: 409,
      });
    const ids = status.competitions.map((c) => c.id);
    await tx.tournament.update({ where: { id: tournamentId }, data: { archivedAt: now, completionNextCheckAt: null } });
    if (ids.length)
      await tx.ftlSyncState.updateMany({ where: { competitionId: { in: ids } }, data: { nextAutomaticAt: null } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Tournoi archivé manuellement',
        targetType: 'Tournament',
        targetId: tournamentId,
        after: {
          archivedAt: now.toISOString(),
          incomplete: status.competitions.filter((c) => !c.complete).map((c) => c.name),
          openMatches: status.openMatches,
        },
      },
    });
    return { ...status, archivedAt: now };
  });
}

async function unarchive(db, tournamentId, actorId, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id=${tournamentId} FOR UPDATE`;
    const t = await tx.tournament.findUnique({ where: { id: tournamentId }, include: { competitions: true } });
    if (!t) throw Object.assign(new Error('Tournoi introuvable.'), { status: 404 });
    if (!t.archivedAt) throw Object.assign(new Error('Ce tournoi n’est pas archivé.'), { status: 409 });
    const ids = t.competitions.map((c) => c.id);
    await tx.tournament.update({
      where: { id: tournamentId },
      data: { archivedAt: null, completionNextCheckAt: null },
    });
    // Reprend le suivi automatique des épreuves qui n'étaient pas terminées.
    if (ids.length)
      await tx.ftlSyncState.updateMany({
        where: { competitionId: { in: ids }, NOT: { status: 'COMPLETE' } },
        data: { nextAutomaticAt: now },
      });
    await tx.auditLog.create({
      data: { actorId, action: 'Tournoi désarchivé', targetType: 'Tournament', targetId: tournamentId },
    });
    return { id: tournamentId, archivedAt: null };
  });
}

module.exports.archiveStatus = archiveStatus;
module.exports.archiveManually = archiveManually;
module.exports.unarchive = unarchive;
