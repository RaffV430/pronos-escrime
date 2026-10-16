const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const F = require('../src/services/officialFormat');
const E = require('../src/services/engardeParser');
const { observeTableau } = require('../src/services/engardeSync');
const fixture = (n) => fs.readFileSync(`${__dirname}/fixtures/engarde/${n}`, 'utf8');
const config = {
  event: 'TEST Senior',
  eventId: 'A'.repeat(32),
  eventTime: 'Friday, October 16, 2026 9:00 AM',
  date: '2026-10-16',
  time: '9:00 AM',
  timezone: 'Asia/Tokyo',
  tournament: 'TEST World Cup',
};
const ftl = (text) =>
  `<span class="desktop tournName">${config.tournament}</span><span class="desktop eventName">${config.event}</span><span class="desktop eventTime">${config.eventTime}</span><div id="mainContent">${text}</div>`;
const formula =
  'Incomplete tableau of 128 fenced until 32 competitors remain. Complete tableau of 64 fenced through the finals.';
const source = `https://www.fencingtimelive.com/events/format/${config.eventId}`;
test('FTL : formule J1/J2 avant toute publication de tableau ; identité et formule ambiguë contrôlées', async () => {
  const page = ftl('') + `<a href="${source}">Format</a>`;
  const plan = await F.readFtl(config, page, {
    get: async (url) => {
      assert.equal(url, source);
      return ftl(formula);
    },
  });
  assert.equal(plan.kind, 'split');
  assert.equal(plan.preliminaryUntil, 'T64');
  assert.equal(F.ftl(ftl('Complete tableau of 128 fenced through the finals.'), config, source).kind, 'continuous');
  assert.equal(F.ftl(ftl('Incomplete tableau of 128 fenced until 16 competitors remain.'), config, source), null);
  assert.throws(() => F.ftl(ftl(formula), { ...config, event: 'Other event' }, source), /Identité/);
  assert.equal(await F.readFtl(config, ftl(''), { get: () => assert.fail('aucune adresse devinée') }), null);
});
test('Engarde : vrais formats Grand Prix séparé et nationale continue, pas de J2 inventé', () => {
  const split = F.engarde(
    fixture('doha-formule.html'),
    { event: 'Grand Prix du Qatar Epee Hommes Senior' },
    'official',
  );
  assert.equal(split.kind, 'split');
  assert.equal(split.preliminaryUntil, 'T64');
  assert.equal(split.scheduleSessions, undefined);
  assert.equal(
    F.engarde(
      '<h1>TEST Dames</h1><p>Tableau préliminaire avec 32 qualifiées. Tableau principal de 64</p>',
      { event: 'TEST Dames' },
      'official',
    ).kind,
    'split',
  );
  assert.equal(
    F.engarde(fixture('national-formule.html'), { event: 'Epée Hommes Senior' }, 'official').kind,
    'continuous',
  );
  assert.throws(() => F.engarde(fixture('doha-formule.html'), { event: 'Other event' }, 'official'), /correspond pas/);
});
const base = '/competition/test/worldcup/senior/';
const menu = `<a class="link-competition" href="${base}formule.htm">Formule</a><a class="link-competition" href="${base}tableauPreliminaire.htm">Tableau préliminaire de 256</a><a class="link-competition" href="${base}tableau64.htm">Tableau principal de 64</a>`;
const engConfig = {
  ...config,
  provider: 'engarde',
  eventSourceUrl: 'https://engarde-service.com' + base.slice(0, -1),
  preliminaryUntil: 'T64',
};
const pages = E.competitionPages(menu, { org: 'test', event: 'worldcup', compe: 'senior' });
test('Engarde : liens observés seulement, formule et tableau préliminaire suivis', () => {
  assert.equal(pages.tableaus.length, 2);
  assert.equal(pages.preliminary.length, 1);
  assert.match(pages.format, /formule.htm$/);
  const foreign = E.competitionPages(menu.replaceAll(base, '/competition/other/worldcup/senior/'), {
    org: 'test',
    event: 'worldcup',
    compe: 'senior',
  });
  assert.equal(foreign.tableaus.length, 0);
  assert.equal(foreign.format, undefined);
});
function setup() {
  const prelim = fixture('doha-prelim-anonymous.html'),
    main = fixture('doha-main-anonymous.html');
  const names = [
    ...new Set(
      [prelim, main].flatMap((html) => E.parseTableaus([html]).matches.flatMap((m) => [m.player1, m.player2])),
    ),
  ];
  const c = { id: 1, podiumRoster: names.map((name, i) => ({ id: String(i + 1), name })) };
  const client = { get: async (url) => (url.includes('Preliminaire') ? prelim : main) };
  return { c, client };
}
test('Engarde : deux T64 simultanés restent distincts ; J1 sans finale ni faux podium', async () => {
  const { c, client } = setup();
  const out = await observeTableau(c, engConfig, pages, client);
  assert.equal(out.matches.filter((m) => m.round === 'J1:T64').length, 32);
  assert.equal(out.matches.filter((m) => m.round === 'T64').length, 32);
  assert.equal(new Set(out.matches.map((m) => m.sourceKey)).size, out.matches.length);
  assert.ok(out.matches.filter((m) => m.round.startsWith('J1:')).every((m) => m.sourceUrl.endsWith('/preliminary')));
  assert.ok(out.matches.filter((m) => !m.round.startsWith('J1:')).every((m) => m.startsAt === null));
  assert.equal(out.officialPodium, null);
  const first = await observeTableau(c, engConfig, { ...pages, tableaus: pages.preliminary }, client);
  assert.ok(first.matches.every((m) => m.round.startsWith('J1:')));
  const repeated = await observeTableau(c, engConfig, pages, client);
  assert.deepEqual(repeated.matches, out.matches);
  await assert.rejects(observeTableau(c, { ...engConfig, preliminaryUntil: undefined }, pages, client), /Formule/);
});
test('formule relue après publication tardive et journalisée sans toucher aux données sportives', async () => {
  let stored = { ...config, eventSourceUrl: 'https://www.fencingtimelive.com/events/view/' + config.eventId };
  const writes = [];
  const db = {
    $transaction: async (fn) =>
      fn({
        $queryRaw: async () => [],
        auditLog: {
          findFirst: async ({ where }) => (where.action === 'Configuration FTL validée' ? { after: stored } : null),
          create: async ({ data }) => {
            writes.push(data);
            stored = data.after;
          },
        },
      }),
  };
  let published = false;
  let reads = 0;
  const client = {
    eventPage: async () => ({ html: ftl('') + (published ? `<a href="${source}">Format</a>` : '') }),
    get: async () => {
      reads++;
      return ftl(formula);
    },
  };
  assert.equal(await F.refresh(db, { id: 1 }, stored, 1, client), stored);
  assert.equal(writes.length, 0);
  published = true;
  const next = await F.refresh(db, { id: 1 }, stored, 1, client);
  assert.equal(next.preliminaryUntil, 'T64');
  assert.equal(writes.length, 1);
  await F.refresh(db, { id: 1 }, next, 1, client);
  assert.equal(reads, 1);
  assert.equal(writes.length, 1);
});
