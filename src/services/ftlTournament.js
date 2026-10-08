const { load } = require('cheerio');
const { createClient, failure, ORIGIN } = require('./ftlClient');
const { clean, norm } = require('./ftlParser');
const { parseRoster, SOURCE, configuration } = require('./ftlConfiguration');
const { cleanCity, utcOffset, offsetLabel } = require('./venue');
const SCHEDULE = /^https:\/\/www\.fencingtimelive\.com\/tournaments\/eventSchedule\/([a-f0-9]{32})$/i;
const CONFIG = 'Configuration FTL validée';
function scheduleUrl(value) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    throw failure('Lien du calendrier FencingTimeLive requis.', 400);
  }
  u.hash = '';
  if (!SCHEDULE.test(u.href))
    throw failure('Utilisez le lien SCHEDULE du tournoi FencingTimeLive, ou le lien du tournoi engarde-service.', 400);
  u.pathname = u.pathname.replace(/[a-f0-9]{32}$/i, (id) => id.toUpperCase());
  return u.href;
}
function parseSchedule(html, sourceUrl, timezone, city = null) {
  try {
    if (!timezone) throw Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw failure('Fuseau horaire IANA requis, par exemple Europe/Istanbul.', 400);
  }
  const $ = load(html),
    tournament = clean($('.desktop.tournName').text()),
    events = [];
  if (!tournament) throw failure('Nom officiel du tournoi introuvable.');
  $('table.scheduleTable').each((_, table) => {
    const heading = clean($(table).prevAll('h5').first().text()),
      stamp = Date.parse(heading + ' UTC');
    if (!Number.isFinite(stamp)) throw failure('Date du calendrier non vérifiable.');
    $(table)
      .find('tbody tr[id^="ev_"]')
      .each((_, row) => {
        const eventId = ($(row).attr('id') || '').slice(3).toUpperCase(),
          link = $(row).find('a[href^="/events/view/"]');
        const eventSourceUrl = new URL(link.attr('href') || '/', ORIGIN).href,
          event = clean(link.text());
        if (
          !/^[A-F0-9]{32}$/.test(eventId) ||
          eventSourceUrl !== `${ORIGIN}/events/view/${eventId}` ||
          !event ||
          link.length !== 1
        )
          throw failure('Une épreuve du calendrier est ambiguë.');
        const time = clean($(row).children('td').first().text());
        if (!/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(time)) throw failure('Horaire local non vérifiable.');
        events.push({
          eventId,
          eventSourceUrl,
          event,
          date: new Date(stamp).toISOString().slice(0, 10),
          time,
          format: /\bteam\b/i.test(event) ? 'TEAM' : 'INDIVIDUAL',
          timezone,
          ...(city ? { city } : {}),
          tournament,
          scheduleUrl: sourceUrl,
        });
      });
  });
  if (!events.length || events.length > 128 || new Set(events.map((e) => e.eventId)).size !== events.length)
    throw failure('Liste des épreuves absente ou incohérente.');
  return { sourceUrl, tournament, timezone, ...(city ? { city } : {}), events };
}
function linksOf($) {
  return $('a[href]')
    .toArray()
    .map((a) => new URL($(a).attr('href'), ORIGIN).href);
}
// No URL guessing: the event link comes from SCHEDULE; roster and rounds come from that event page.
async function readEvent(event, client) {
  const page = await client.eventPage(event.eventSourceUrl),
    $ = load(page.html),
    // La page d'épreuve redirige vers le tableau une fois publié : son adresse compte comme lien.
    links = [...linksOf($), page.url].map((u) => u.replace(/#.*$/, ''));
  const eventTime = clean($('.desktop.eventTime').text()),
    stamp = Date.parse(eventTime + ' UTC');
  if (
    norm($('.desktop.tournName').text()) !== norm(event.tournament) ||
    norm($('.desktop.eventName').text()) !== norm(event.event) ||
    !Number.isFinite(stamp) ||
    new Date(stamp).toISOString().slice(0, 10) !== event.date ||
    stamp !== Date.parse(event.date + ' ' + event.time + ' UTC') ||
    /\bteam\b/i.test(event.event) !== (event.format === 'TEAM') ||
    !links.includes(event.scheduleUrl)
  )
    throw failure('Identité, date ou tournoi de l’épreuve non concordants.');
  const rosterSourceUrl = links.find((u) => u === `${ORIGIN}/events/competitors/${event.eventId}`);
  const related = [
    ...new Set(links.filter((u) => SOURCE.test(u) && SOURCE.exec(u)[2].toUpperCase() === event.eventId)),
  ];
  const tableaus = related.filter((u) => u.includes('/tableaus/'));
  if (tableaus.length > 1) throw failure('Plusieurs tableaux principaux : vérification individuelle nécessaire.');
  let roster = null;
  if (rosterSourceUrl) {
    const rosterPage = load(await client.get(rosterSourceUrl));
    if (
      norm(rosterPage('.desktop.tournName').text()) !== norm(event.tournament) ||
      norm(rosterPage('.desktop.eventName').text()) !== norm(event.event) ||
      norm(rosterPage('.desktop.eventTime').text()) !== norm(eventTime)
    )
      throw failure('La liste des engagés ne correspond pas à l’épreuve.');
    const dataUrl = rosterPage('#compList').attr('data-url');
    if (dataUrl !== `/events/competitors/data/${event.eventId}`) throw failure('Liste des engagés non reconnue.');
    const rows = await client.get(dataUrl);
    if (!Array.isArray(rows)) throw failure('Liste des engagés non vérifiable.');
    if (rows.length) roster = parseRoster(rows);
  }
  return {
    config: {
      ...event,
      eventTime,
      rosterSourceUrl: rosterSourceUrl || null,
      sourceUrl: tableaus[0] || null,
      poolSources: related.filter((u) => u.includes('/pools/')),
    },
    roster,
  };
}
const linkedSelection = {
  id: true,
  name: true,
  tournamentId: true,
  rosterSourceUrl: true,
  ftlEventId: true,
  matches: { select: { sourceUrl: true } },
  pools: { select: { sourceUrl: true } },
};
function eventIds(c) {
  return [
    ...new Set(
      [
        c.ftlEventId,
        ...[
          c.rosterSourceUrl,
          ...(c.matches || []).map((m) => m.sourceUrl),
          ...(c.pools || []).map((p) => p.sourceUrl),
        ].map((u) =>
          String(u || '')
            .match(/(?:competitors|scores)\/([a-f0-9]{32})(?:\/|$)/i)?.[1]
            ?.toUpperCase(),
        ),
      ].filter(Boolean),
    ),
  ];
}
function matching(existing, eventId) {
  const found = existing.filter((c) => eventIds(c).includes(eventId));
  if (found.length > 1) throw failure('Une source est déjà reliée à plusieurs épreuves. Vérification requise.', 409);
  return found[0];
}
async function preview(db, input, actorId, client = createClient()) {
  // Lien engarde-service : même écran d'aperçu, lu par son propre module.
  if (require('./engardeParser').parseLink(input.sourceUrl))
    return require('./engardeTournament').preview(db, input, actorId);
  const sourceUrl = scheduleUrl(input.sourceUrl);
  await client.login();
  const parsed = parseSchedule(
    await client.get(sourceUrl),
    sourceUrl,
    String(input.timezone || ''),
    cleanCity(input.city),
  );
  const existing = await db.competition.findMany({ select: linkedSelection });
  const events = parsed.events.map((e) => ({ ...e, existingCompetitionId: matching(existing, e.eventId)?.id || null }));
  // Heure de début convertie en UTC : l'interface l'affiche aussi à l'heure de Paris pour vérification.
  const { eventStart } = require('./eventStart');
  const first = eventStart(parsed.events[0]);
  const shown = events.map((e) => {
    const start = eventStart(e);
    return { ...e, startsAt: start ? new Date(start).toISOString() : null };
  });
  const saved = await db.auditLog.create({
    data: {
      actorId,
      action: 'Aperçu tournoi FTL',
      targetType: 'FtlTournamentPreview',
      targetId: actorId,
      after: { ...parsed, events },
    },
  });
  return {
    ...parsed,
    events: shown,
    offset: offsetLabel(utcOffset(parsed.timezone, first || Date.now())),
    previewId: saved.id,
  };
}
async function save(db, input, actorId, client = createClient()) {
  // Aperçu engarde-service : enregistrement par son module.
  const preview = Number.isSafeInteger(Number(input.previewId))
    ? await db.auditLog.findUnique({ where: { id: Number(input.previewId) } })
    : null;
  if (preview?.targetType === 'EngardePreview') return require('./engardeTournament').save(db, input, actorId);
  const previewId = Number(input.previewId),
    ids = input.eventIds;
  if (
    !Number.isSafeInteger(previewId) ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 128 ||
    ids.some((i) => typeof i !== 'string') ||
    new Set(ids).size !== ids.length
  )
    throw failure('Sélectionnez au moins une épreuve.', 400);
  const entry = await db.auditLog.findUnique({ where: { id: previewId } });
  if (
    !entry ||
    entry.actorId !== actorId ||
    entry.targetType !== 'FtlTournamentPreview' ||
    Date.now() - entry.createdAt.getTime() > 900000
  )
    throw failure('Aperçu expiré. Relisez le calendrier.', 409);
  const selected = entry.after.events.filter((e) => ids.includes(e.eventId));
  if (selected.length !== ids.length) throw failure('Sélection extérieure à cet aperçu.', 400);
  await client.login();
  const fresh = parseSchedule(
    await client.get(entry.after.sourceUrl),
    entry.after.sourceUrl,
    entry.after.timezone,
    entry.after.city || null,
  );
  const observations = [];
  for (const e of selected) {
    const latest = fresh.events.find((x) => x.eventId === e.eventId);
    if (!latest || ['event', 'date', 'time', 'format', 'tournament'].some((k) => latest[k] !== e[k]))
      throw failure('Le calendrier a changé. Relisez les épreuves.', 409);
    try {
      observations.push(await readEvent(latest, client));
    } catch (e) {
      throw failure(`${latest.event} : ${e.status ? e.message : 'source indisponible'}`, e.status || 502);
    }
  }
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184722)`;
      const all = await tx.competition.findMany({ select: linkedSelection });
      const existing = ids.map((id) => matching(all, id)).filter(Boolean);
      const targetIds = [...new Set(existing.map((c) => c.tournamentId))];
      const linked = await tx.tournament.findUnique({ where: { ftlSourceUrl: fresh.sourceUrl } });
      if (linked) targetIds.push(linked.id);
      if (new Set(targetIds).size > 1)
        throw failure('Ces épreuves sont déjà réparties entre plusieurs tournois. Vérification requise.', 409);
      let tournament = targetIds.length ? await tx.tournament.findUnique({ where: { id: targetIds[0] } }) : null;
      if (tournament?.ftlSourceUrl && tournament.ftlSourceUrl !== fresh.sourceUrl)
        throw failure('Le tournoi est déjà relié à une autre source.', 409);
      tournament = tournament
        ? await tx.tournament.update({ where: { id: tournament.id }, data: { ftlSourceUrl: fresh.sourceUrl } })
        : await tx.tournament.create({ data: { name: fresh.tournament, ftlSourceUrl: fresh.sourceUrl } });
      const results = [];
      for (const observation of observations) {
        const { config, roster } = observation;
        let c = matching(existing, config.eventId),
          created = !c;
        if (c) {
          await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
          c = await tx.competition.findUnique({ where: { id: c.id } });
        } else
          c = await tx.competition.create({
            data: {
              name: config.event,
              tournamentId: tournament.id,
              podiumFormat: config.format,
              ftlEventId: config.eventId,
            },
          });
        await applyEvent(tx, c, observation, actorId);
        results.push({
          competitionId: c.id,
          name: c.name,
          created,
          pending: !roster || (!config.sourceUrl && !config.poolSources.length),
          entries: roster?.length || 0,
        });
      }
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'Tournoi FTL configuré',
          targetType: 'Tournament',
          targetId: tournament.id,
          after: { sourceUrl: fresh.sourceUrl, events: results },
        },
      });
      return { tournamentId: tournament.id, name: tournament.name, events: results };
    },
    { timeout: 30000 },
  );
}
// Un retrait officiel ne supprime jamais un engagé figé ni ses pronostics.
// Le contrôle automatique accepte seulement un sous-ensemble des mêmes identités.
function rosterIsSubset(current, observed) {
  if (!Array.isArray(observed) || !observed.length) return false;
  const known = new Map(current.map((e) => [e.id, norm(e.name)]));
  return (
    new Set(observed.map((e) => e.id)).size === observed.length &&
    observed.every((e) => known.has(e.id) && known.get(e.id) === norm(e.name))
  );
}
async function applyEvent(tx, c, { config, roster }, actorId, allowWithdrawals = false) {
  if (
    c.podiumFormat !== config.format ||
    (c.ftlEventId && c.ftlEventId !== config.eventId) ||
    (c.rosterSourceUrl && c.rosterSourceUrl !== config.rosterSourceUrl)
  )
    throw failure('L’identité existante diffère de la source.', 409);
  const identity = (r) => JSON.stringify(r.map((x) => [x.id, norm(x.name)]).sort((a, b) => a[0].localeCompare(b[0])));
  if (
    c.podiumRoster &&
    (!roster ||
      (identity(c.podiumRoster) !== identity(roster) && !(allowWithdrawals && rosterIsSubset(c.podiumRoster, roster))))
  )
    throw failure('Les engagés existants diffèrent : vérification individuelle requise.', 409);
  const sources = await tx.match.findMany({
    where: { competitionId: c.id, sourceUrl: { not: null } },
    select: { sourceUrl: true },
  });
  if (sources.some((m) => SOURCE.exec(m.sourceUrl)?.[2]?.toUpperCase() !== config.eventId))
    throw failure('Une rencontre existante appartient à une autre source.', 409);
  const previous = await configuration(tx, c.id);
  if (previous?.sourceUrl && previous.sourceUrl !== config.sourceUrl)
    throw failure('Le tableau configuré a changé. Vérification individuelle requise.', 409);
  await tx.competition.update({
    where: { id: c.id },
    data: {
      ftlEventId: config.eventId,
      ...(!c.podiumRoster && roster
        ? { podiumRoster: roster, rosterSourceUrl: config.rosterSourceUrl, rosterCheckedAt: new Date() }
        : {}),
    },
  });
  await tx.auditLog.create({
    data: { actorId, action: CONFIG, targetType: 'Competition', targetId: c.id, after: { ...config, name: c.name } },
  });
}
// Épreuve configurée par un lien de poules avant la publication du tableau (sans page d'épreuve
// mémorisée) : à chaque contrôle, le tableau est recherché sur la page officielle de l'épreuve, puis
// enregistré dans la configuration. Aucun tableau deviné : un seul lien, de la même épreuve.
async function discoverTableau(db, c, config, actorId, client) {
  if (config.sourceUrl || config.eventSourceUrl || !/^[a-f0-9]{32}$/i.test(config.eventId || '')) return config;
  const eventId = config.eventId.toUpperCase();
  const page = await client.eventPage(`${ORIGIN}/events/view/${eventId}`);
  const $ = load(page.html);
  if (
    norm($('.desktop.tournName').text()) !== norm(config.tournament) ||
    norm($('.desktop.eventName').text()) !== norm(config.event) ||
    norm($('.desktop.eventTime').text()) !== norm(config.eventTime)
  )
    throw failure('Page officielle de l’épreuve non concordante : tableau non recherché.');
  const tableaus = [
    ...new Set(
      [...linksOf($), page.url]
        .map((u) => u.replace(/#.*$/, ''))
        .filter((u) => u.includes('/tableaus/') && SOURCE.test(u) && SOURCE.exec(u)[2].toUpperCase() === eventId),
    ),
  ];
  if (tableaus.length > 1) throw failure('Plusieurs tableaux publiés : sélection manuelle nécessaire.');
  if (!tableaus.length) return config;
  const next = { ...config, sourceUrl: tableaus[0] };
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    const previous = await configuration(tx, c.id);
    if (!previous || previous.sourceUrl || String(previous.eventId).toUpperCase() !== eventId)
      throw failure('Configuration modifiée pendant le contrôle.', 409);
    await tx.auditLog.create({
      data: { actorId, action: CONFIG, targetType: 'Competition', targetId: c.id, after: { ...next, name: c.name } },
    });
  });
  return next;
}
async function refreshPending(db, c, config, actorId, client) {
  if (!config.eventSourceUrl || (c.podiumRoster && config.sourceUrl)) return { c, config };
  const observation = await readEvent(config, client);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184722)`;
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    const current = await tx.competition.findUnique({ where: { id: c.id } });
    if (current.name !== c.name || JSON.stringify(current.podiumRoster) !== JSON.stringify(c.podiumRoster))
      throw failure('Configuration modifiée pendant le contrôle.', 409);
    await applyEvent(tx, current, observation, actorId, true);
  });
  return {
    c: await db.competition.findUnique({ where: { id: c.id } }),
    config: { ...observation.config, name: c.name },
  };
}
module.exports = {
  scheduleUrl,
  parseSchedule,
  readEvent,
  preview,
  save,
  refreshPending,
  discoverTableau,
  rosterIsSubset,
};
