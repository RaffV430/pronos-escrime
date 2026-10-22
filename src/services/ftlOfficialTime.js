// Only a changed hour on the same official day/event is refreshed automatically.
// Calendar and event page must agree; identity/date changes still require review.
const { load } = require('cheerio');
const { norm, clean } = require('./ftlParser');
const { ORIGIN, failure } = require('./ftlClient');
const { configuration } = require('./ftlConfiguration');
const { eventStart } = require('./eventStart');
const { isDeepStrictEqual } = require('node:util');
function stamp(value) {
  const text = clean(value);
  if (!/\b\d{1,2}:\d{2}\s*(AM|PM)$/i.test(text)) return null;
  const at = Date.parse(text + ' UTC');
  return Number.isFinite(at) ? at : null;
}
async function refresh(db, c, config, actorId, client, now = Date.now()) {
  if (!/^[a-f0-9]{32}$/i.test(config.eventId || '') || !config.eventTime) return config;
  const id = config.eventId.toUpperCase();
  if (
    (c.ftlEventId && c.ftlEventId.toUpperCase() !== id) ||
    (c.rosterSourceUrl && c.rosterSourceUrl.toUpperCase() !== `${ORIGIN}/events/competitors/${id}`.toUpperCase())
  )
    throw failure('La source configurée ne correspond pas à cette épreuve.');
  const page = await client.eventPage(`${ORIGIN}/events/view/${id}`);
  const $ = load(page.html);
  const eventTime = clean($('.desktop.eventTime').text());
  const nextStamp = stamp(eventTime),
    oldStamp = stamp(config.eventTime);
  const links = $('a[href]')
    .toArray()
    .map((a) => new URL($(a).attr('href'), ORIGIN).href);
  const rosterUrl = `${ORIGIN}/events/competitors/${id}`;
  if (
    norm($('.desktop.tournName').text()) !== norm(config.tournament) ||
    norm($('.desktop.eventName').text()) !== norm(config.event) ||
    nextStamp === null ||
    oldStamp === null ||
    new Date(nextStamp).toISOString().slice(0, 10) !== config.date ||
    !links.includes(rosterUrl) ||
    !new RegExp(
      `^${ORIGIN}/(?:events/(?:view|competitors|format|results)|(?:pools|tableaus)/scores)/${id}(?:/[a-f0-9]{32})?(?:\\?.*)?$`,
      'i',
    ).test(page.url)
  )
    throw failure('Identité ou date officielle différente : changement d’horaire non accepté.');
  const time = /\d{1,2}:\d{2}\s*(AM|PM)$/i.exec(eventTime)[0];
  if (eventTime === config.eventTime && (!config.time || stamp(`${config.date} ${config.time}`) === nextStamp))
    return config;
  const { parseSchedule, scheduleUrl } = require('./ftlTournament');
  const source =
    config.scheduleUrl ||
    links.find((u) => /^https:\/\/www\.fencingtimelive\.com\/tournaments\/eventSchedule\/[a-f0-9]{32}$/i.test(u));
  if (!source || !links.includes(source)) throw failure('Calendrier officiel absent : horaire à vérifier.');
  const url = scheduleUrl(source);
  const calendar = parseSchedule(await client.get(url), url, config.timezone, config.city, { allowUnknownTime: true });
  const event = calendar.events.find((e) => e.eventId === id);
  if (
    !event ||
    !isDeepStrictEqual(
      (event.scheduleSessions || []).map((s) => s.date),
      (config.scheduleSessions || []).map((s) => s.date),
    ) ||
    norm(event.event) !== norm(config.event) ||
    norm(calendar.tournament) !== norm(config.tournament) ||
    event.date !== config.date ||
    event.format !== config.format ||
    stamp(`${event.date} ${event.time}`) !== nextStamp
  )
    throw failure('Calendrier et page officielle non concordants : horaire à vérifier.');
  const { nameAliases, ...expected } = config;
  const next = {
    ...expected,
    eventTime,
    time,
    scheduleUrl: url,
    ...(event.scheduleSessions ? { scheduleSessions: event.scheduleSessions } : {}),
  };
  const oldStart = eventStart(config),
    nextStart = eventStart(next);
  // Keep the expired freshness cutoff too: a postponement must not reopen a grace period.
  if (oldStart !== null && oldStart <= now && nextStart > oldStart)
    next.predictionStartAt = new Date(
      Math.min(oldStart, Date.parse(config.predictionStartAt) || oldStart),
    ).toISOString();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
    if (!isDeepStrictEqual(await configuration(tx, c.id), expected))
      throw failure('Configuration modifiée pendant le contrôle.', 409);
    await tx.auditLog.create({
      data: { actorId, action: 'Configuration FTL validée', targetType: 'Competition', targetId: c.id, after: next },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'Horaire officiel actualisé',
        targetType: 'Competition',
        targetId: c.id,
        before: { eventTime: config.eventTime, time: config.time || null },
        after: { eventTime, time },
      },
    });
  });
  return { ...next, ...(nameAliases ? { nameAliases } : {}) };
}
module.exports = { refresh };
