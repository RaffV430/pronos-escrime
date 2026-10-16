// Read the published sporting formula; calendar labels alone never invent a second bracket.
const { load } = require('cheerio');
const { clean, norm } = require('./ftlParser');
const { failure, ORIGIN } = require('./ftlClient');
const compact = (text) =>
  clean(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
function ftl(html, config, sourceUrl) {
  const $ = require('./ftlSync').verifyPage(html, config);
  const text = compact($('#mainContent').text());
  const prelim = /incomplete tableau of (\d+) fenced until (\d+) competitors remain\./.exec(text);
  const main = /complete tableau of (\d+) fenced through the finals\./.exec(text);
  if (prelim && main && Number(prelim[2]) === 32 && Number(main[1]) === 64 && Number(prelim[1]) >= 64)
    return { kind: 'split', preliminaryUntil: 'T64', mainRound: 'T64', sourceUrl };
  if (/incomplete tableau|preliminary|repech/.test(text)) return null;
  if (main) return { kind: 'continuous', sourceUrl };
  return null;
}
function engarde(html, config, sourceUrl) {
  const $ = load(html);
  // The heading and same-competition Formule link are checked, not the unrelated site navigation.
  const heading = clean($('h1').last().text());
  if (!heading || norm(heading) !== norm(config.event))
    throw failure('La formule engarde ne correspond pas à cette épreuve.');
  const text = compact($('body').clone().find('script,style,nav,footer').remove().end().text());
  if (/repech/.test(text)) return null;
  if (/tableau preliminaire/.test(text) && /32 qualifies/.test(text) && /tableau principal de 64/.test(text))
    return { kind: 'split', preliminaryUntil: 'T64', mainRound: 'T64', sourceUrl };
  if (/tableau preliminaire|tableau principal/.test(text)) return null;
  if (/tableau direct/.test(text)) return { kind: 'continuous', sourceUrl };
  return null;
}
function ftlLink(html, config) {
  const expected = `${ORIGIN}/events/format/${config.eventId}`;
  const $ = load(html);
  return $('a[href]')
    .toArray()
    .some((a) => new URL($(a).attr('href'), ORIGIN).href === expected)
    ? expected
    : null;
}
async function readFtl(config, eventHtml, client) {
  const sourceUrl = ftlLink(eventHtml, config);
  return sourceUrl ? ftl(await client.get(sourceUrl), config, sourceUrl) : null;
}
// A failed or absent formula is retried, while repeated live controls reuse a short read cache.
const cache = new WeakMap();
async function refresh(db, c, config, actorId, client, pages = null) {
  let entries = cache.get(db);
  if (!entries) {
    entries = new Map();
    cache.set(db, entries);
  }
  const key = JSON.stringify([c.id, config.provider, config.eventId, config.event, config.eventTime, config.date]);
  const cached = entries.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return config;
  let plan;
  if (config.provider === 'engarde') {
    if (!pages?.format) return config;
    plan = engarde(await client.get(pages.format), config, pages.format);
  } else {
    const page = await client.eventPage(config.eventSourceUrl || `${ORIGIN}/events/view/${config.eventId}`);
    require('./ftlSync').verifyPage(page.html, config);
    plan = await readFtl(config, page.html, client);
  }
  if (!plan) return config;
  if (config.eventFormat && config.eventFormat.kind !== plan.kind)
    throw failure('La formule officielle a changé : phases conservées, vérification administrateur requise.');
  const next = {
    ...config,
    eventFormat: plan,
    ...(plan.kind === 'split' ? { preliminaryUntil: plan.preliminaryUntil, formatSourceUrl: plan.sourceUrl } : {}),
  };
  if (!require('node:util').isDeepStrictEqual(next, config)) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
      const previous = await require('./ftlConfiguration').configuration(tx, c.id);
      if (!require('node:util').isDeepStrictEqual(previous, config))
        throw failure('Configuration modifiée pendant le contrôle.', 409);
      await tx.auditLog.create({
        data: { actorId, action: 'Configuration FTL validée', targetType: 'Competition', targetId: c.id, after: next },
      });
    });
  }
  entries.set(key, { at: Date.now() });
  return next;
}
module.exports = { ftl, engarde, readFtl, refresh };
