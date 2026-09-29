const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverTableau } = require('../src/services/ftlTournament');

const ID = '472B8F37367C4548B8D502F3D81E1476';
const TABLEAU = `https://www.fencingtimelive.com/tableaus/scores/${ID}/C0FE2BF68DE04E0197CA8593F0DD74F9`;
const POOLS = `https://www.fencingtimelive.com/pools/scores/${ID}/F30EF172C645433CACE2CAF2E876630F`;
const config = {
  date: '2026-09-29',
  event: "Senior Men's Foil",
  eventId: ID,
  eventTime: 'Tuesday, September 29, 2026 9:00 AM',
  format: 'INDIVIDUAL',
  name: "Senior Men's Foil",
  poolSources: [POOLS],
  rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${ID}`,
  sourceUrl: null,
  timezone: 'Europe/Istanbul',
  tournament: '49th CISM World Military Fencing',
};
const page = (links, { event = config.event } = {}) => `
  <span class="desktop tournName">${config.tournament}</span>
  <span class="desktop eventName">${event}</span>
  <span class="desktop eventTime">
     ${config.eventTime}
  </span>
  ${links.map((l) => `<a href="${l}">x</a>`).join('')}`;
const db = (stored = config) => {
  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    auditLog: {
      findFirst: async () => ({ after: stored }),
      create: async ({ data }) => (writes.push(data), data),
    },
  };
  return { writes, $transaction: async (fn) => fn(tx) };
};
const client = (html, url = TABLEAU) => ({ eventPage: async () => ({ html, url }) });

test('tableau published after a pool-only configuration is found and saved (event page redirects to it)', async () => {
  const d = db();
  const next = await discoverTableau(
    d,
    { id: 9, name: config.name },
    config,
    0,
    client(page([`/tableaus/scores/${ID}/C0FE2BF68DE04E0197CA8593F0DD74F9#`, POOLS, `/events/results/${ID}`])),
  );
  assert.equal(next.sourceUrl, TABLEAU);
  assert.equal(d.writes.length, 1);
  assert.equal(d.writes[0].action, 'Configuration FTL validée');
  assert.equal(d.writes[0].after.sourceUrl, TABLEAU);
  assert.deepEqual(d.writes[0].after.poolSources, [POOLS]);
});

test('no tableau yet, already known, other event or ambiguity: nothing saved', async () => {
  const d = db();
  const c = { id: 9, name: config.name };
  const eventUrl = `https://www.fencingtimelive.com/events/view/${ID}`;
  assert.equal((await discoverTableau(d, c, config, 0, client(page([POOLS]), eventUrl))).sourceUrl, null);
  const known = { ...config, sourceUrl: TABLEAU };
  assert.equal(await discoverTableau(d, c, known, 0, { eventPage: () => assert.fail('no read') }), known);
  const other = `https://www.fencingtimelive.com/tableaus/scores/${'A'.repeat(32)}/${'B'.repeat(32)}`;
  assert.equal((await discoverTableau(d, c, config, 0, client(page([other]), eventUrl))).sourceUrl, null);
  await assert.rejects(
    discoverTableau(d, c, config, 0, client(page([TABLEAU]), eventUrl) && client(page([TABLEAU], { event: 'Épée' }))),
    /non concordante/,
  );
  await assert.rejects(
    discoverTableau(d, c, config, 0, client(page([TABLEAU, `/tableaus/scores/${ID}/${'C'.repeat(32)}`]), eventUrl)),
    /Plusieurs tableaux/,
  );
  assert.equal(d.writes.length, 0);
});
