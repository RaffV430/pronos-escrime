const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRecomposition, applyRecomposition, describe, poolsNotification } = require('../src/services/poolRecompose');
const { eventStart } = require('../src/services/eventStart');
const { finish } = require('../src/services/ftlScheduler');

const URL_ =
  'https://www.fencingtimelive.com/pools/scores/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const roster = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => ({ name: n }));
let nextId = 100;
const stored = (number, names, extra = {}) => ({
  id: number,
  name: `Poule ${number}`,
  sourceUrl: URL_,
  sourcePoolNumber: number,
  isLocked: false,
  isFinal: false,
  fencers: names.map((name, i) => ({
    id: number * 10 + i,
    name,
    position: i + 1,
    wins: null,
    losses: null,
    indicator: null,
    firstResultAt: null,
  })),
  ...extra,
});
const seen = (number, names, extra = {}) => ({
  number,
  rows: names.map((name, i) => ({ name, position: i + 1, firstResult: false, hasResult: false, ...extra })),
});

test('event start uses the FencingTimeLive local time and the venue time zone', () => {
  const paris = eventStart({ date: '2026-10-10', time: '9:00 AM', timezone: 'Europe/Paris' });
  assert.equal(new Date(paris).toISOString(), '2026-10-10T07:00:00.000Z');
  const pm = eventStart({
    date: '2026-10-10',
    eventTime: 'Saturday, October 10, 2026 1:30 PM',
    timezone: 'Asia/Tokyo',
  });
  assert.equal(new Date(pm).toISOString(), '2026-10-10T04:30:00.000Z');
  const offset = eventStart({
    date: '2026-09-26',
    eventTime: 'Saturday, September 26, 2026 9:00 AM',
    offset: '+03:00',
  });
  assert.equal(new Date(offset).toISOString(), '2026-09-26T06:00:00.000Z');
  assert.equal(
    new Date(eventStart({ date: '2026-10-10', time: '12:15 AM', timezone: 'UTC' })).toISOString(),
    '2026-10-10T00:15:00.000Z',
  );
});

test('pace: 15 min before the pools, last slow check 1 min before their start, then 2 min', async () => {
  const start = '2026-10-10T07:00:00.000Z';
  const pace = async (at) => {
    const state = { competitionId: 1, leaseToken: 't', failures: 0 };
    const db = {
      ftlSyncState: { findUnique: async () => state, updateMany: async ({ data }) => Object.assign(state, data) },
    };
    await finish(
      db,
      1,
      't',
      { warnings: [], eventDate: '2026-10-10', eventStart: start, openFirstResultPools: 4 },
      null,
      new Date(at),
    );
    return state.nextAutomaticAt.toISOString();
  };
  assert.equal(await pace('2026-10-10T05:00:00Z'), '2026-10-10T05:15:00.000Z');
  assert.equal(await pace('2026-10-10T06:50:00Z'), '2026-10-10T06:59:00.000Z', 'capped 1 min before the start');
  assert.equal(await pace('2026-10-10T06:59:10Z'), '2026-10-10T07:01:10.000Z');
});

test('plan: unchanged pools are left alone; changed, added, removed and reordered pools are detected', () => {
  const pools = [stored(1, ['A', 'B', 'C']), stored(2, ['D', 'E', 'F']), stored(3, ['G', 'H'])];
  assert.equal(
    planRecomposition(pools, URL_, [seen(1, ['A', 'B', 'C']), seen(2, ['D', 'E', 'F']), seen(3, ['G', 'H'])], roster),
    null,
  );
  assert.equal(
    planRecomposition([], URL_, [seen(1, ['A', 'B'])], roster),
    null,
    'first import stays with the normal import',
  );
  const plan = planRecomposition(
    pools,
    URL_,
    [seen(1, ['C', 'A', 'B']), seen(2, ['D', 'E', 'G']), seen(4, ['F', 'H'])],
    roster,
  );
  assert.deepEqual(
    plan.reordered.map((x) => x.pool.name),
    ['Poule 1'],
  );
  assert.deepEqual(
    plan.changed.map((x) => x.pool.name),
    ['Poule 2'],
  );
  assert.deepEqual(
    plan.added.map((o) => o.number),
    [4],
  );
  assert.deepEqual(
    plan.removed.map((p) => p.name),
    ['Poule 3'],
  );
});

test('plan: a started pool or an unknown fencer is never rewritten automatically', () => {
  const pools = [stored(1, ['A', 'B', 'C']), stored(2, ['D', 'E', 'F'])];
  const started = [stored(1, ['A', 'B', 'C']), { ...stored(2, ['D', 'E', 'F']) }];
  started[1].fencers[0].firstResultAt = new Date();
  assert.throws(
    () => planRecomposition(started, URL_, [seen(1, ['A', 'B', 'C']), seen(2, ['D', 'E', 'G'])], roster),
    /après leur début/,
  );
  assert.throws(
    () =>
      planRecomposition(
        pools,
        URL_,
        [seen(1, ['A', 'B', 'C']), seen(2, ['D', 'E', 'G'], { firstResult: true })],
        roster,
      ),
    /après leur début/,
  );
  assert.throws(
    () => planRecomposition(pools, URL_, [seen(1, ['A', 'B', 'C']), seen(2, ['D', 'E', 'Z'])], roster),
    /engagés/,
  );
  // Une poule verrouillée à la main est considérée comme commencée.
  assert.throws(
    () => planRecomposition([stored(1, ['A', 'B', 'C'], { isLocked: true })], URL_, [seen(1, ['A', 'B', 'D'])], roster),
    /après leur début/,
  );
});

function fakeDb(pools, predictions, subs) {
  const deliveries = [],
    audits = [];
  const tx = {
    $queryRaw: async () => [],
    pool: {
      findMany: async () =>
        pools
          .filter((p) => p.sourceUrl === URL_)
          .map((p) => ({ ...p, fencers: [...p.fencers].sort((a, b) => a.position - b.position) })),
      update: async ({ where, data }) => {
        const p = pools.find((x) => x.id === where.id);
        const { fencers, ...rest } = data;
        Object.assign(p, rest);
        if (fencers)
          p.fencers = fencers.create.map((f) => ({
            id: nextId++,
            firstResultAt: null,
            wins: null,
            losses: null,
            indicator: null,
            ...f,
          }));
        return p;
      },
      delete: async ({ where }) =>
        pools.splice(
          pools.findIndex((p) => p.id === where.id),
          1,
        ),
      create: async ({ data }) => {
        const { fencers, ...rest } = data;
        const p = {
          id: nextId++,
          isLocked: false,
          isFinal: false,
          ...rest,
          fencers: fencers.create.map((f) => ({ id: nextId++, ...f })),
        };
        pools.push(p);
        return p;
      },
    },
    poolFencer: {
      update: async ({ where, data }) =>
        Object.assign(
          pools.flatMap((p) => p.fencers).find((f) => f.id === where.id),
          data,
        ),
      deleteMany: async ({ where }) => {
        pools.find((p) => p.id === where.poolId).fencers = [];
      },
    },
    poolPrediction: {
      findMany: async ({ where }) => predictions.filter((p) => where.fencerId.in.includes(p.fencerId)),
      deleteMany: async ({ where }) => {
        for (let i = predictions.length - 1; i >= 0; i--)
          if (where.fencerId.in.includes(predictions[i].fencerId)) predictions.splice(i, 1);
      },
    },
    auditLog: { create: async ({ data }) => (audits.push(data), { id: 77, ...data }) },
    pushSubscription: { findMany: async () => subs },
    pushDelivery: { create: async ({ data }) => deliveries.push(data) },
  };
  return { db: { $transaction: (fn) => fn(tx) }, deliveries, audits };
}

test('apply: only changed pools lose their predictions; unchanged and reordered pools keep them; followers are notified', async () => {
  const pools = [stored(1, ['A', 'B', 'C']), stored(2, ['D', 'E', 'F']), stored(3, ['G', 'H'])];
  const predictions = [
    { userId: 1, fencerId: 10 }, // poule 1 (ordre revu) : conservé
    { userId: 1, fencerId: 20 }, // poule 2 (modifiée) : à refaire
    { userId: 2, fencerId: 21 },
    { userId: 2, fencerId: 30 }, // poule 3 (inchangée) : conservé
  ];
  const observed = [seen(1, ['B', 'A', 'C']), seen(2, ['D', 'E', 'F', 'G']), seen(3, ['G', 'H'])];
  // G passe de la poule 3 à la poule 2 : la poule 3 change aussi (H seul ne suffit pas, on la garde telle quelle ici).
  observed[2] = seen(3, ['H', 'G']);
  const plan = planRecomposition(pools, URL_, observed, roster);
  const { db, deliveries, audits } = fakeDb(pools, predictions, [{ id: 's1' }, { id: 's2' }]);
  const c = { id: 5, tournamentId: 9, name: 'Fleuret hommes' };
  const out = await applyRecomposition(db, c, URL_, plan, { date: '2026-10-10' }, new Date('2026-10-09T20:00:00Z'));
  assert.deepEqual(out.changed, ['Poule 2']);
  assert.deepEqual(out.reordered.sort(), ['Poule 1', 'Poule 3']);
  assert.equal(out.predictionsCleared, 2);
  assert.equal(out.players, 2);
  assert.deepEqual(
    predictions.map((p) => p.fencerId).sort(),
    [10, 30],
    'reordered and unchanged pools keep their predictions',
  );
  const p1 = pools.find((p) => p.id === 1);
  assert.deepEqual(
    p1.fencers.sort((a, b) => a.position - b.position).map((f) => [f.id, f.name]),
    [
      [11, 'B'],
      [10, 'A'],
      [12, 'C'],
    ],
  );
  const p2 = pools.find((p) => p.id === 2);
  assert.deepEqual(
    p2.fencers.map((f) => f.name),
    ['D', 'E', 'F', 'G'],
  );
  assert.ok(p2.recomposedAt);
  assert.equal(p1.recomposedAt, undefined, 'a reorder alone is not flagged as modified');
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], {
    subscriptionId: 's1',
    competitionId: 5,
    throughEventId: 0,
    kind: 'POOLS',
    round: 'pools-77',
    matchIds: [2],
  });
  assert.equal(audits[0].action, 'Poules recomposées');
  assert.match(describe(out), /Poule 2 modifiée.*2 pronostic\(s\) à refaire/);
});

test('apply: added and removed pools; no notification for a pure reorder', async () => {
  const pools = [stored(1, ['A', 'B']), stored(2, ['C', 'D'])];
  let plan = planRecomposition(pools, URL_, [seen(1, ['A', 'B']), seen(3, ['C', 'D'])], roster);
  let fake = fakeDb(pools, [{ userId: 1, fencerId: 20 }], [{ id: 's1' }]);
  const c = { id: 5, tournamentId: 9, name: 'Fleuret hommes' };
  const out = await applyRecomposition(fake.db, c, URL_, plan, { date: '2026-10-10' });
  assert.deepEqual([out.added, out.removed], [['Poule 3'], ['Poule 2']]);
  assert.deepEqual(
    pools.map((p) => p.name),
    ['Poule 1', 'Poule 3'],
  );
  assert.equal(fake.deliveries.length, 1);
  plan = planRecomposition(pools, URL_, [seen(1, ['B', 'A']), seen(3, ['C', 'D'])], roster);
  fake = fakeDb(pools, [], [{ id: 's1' }]);
  await applyRecomposition(fake.db, c, URL_, plan, { date: '2026-10-10' });
  assert.equal(fake.deliveries.length, 0);
});

test('notification names the pools to redo and opens the pools tab', () => {
  const n = poolsNotification({ id: 5, tournamentId: 9, name: 'Fleuret hommes' }, [
    { name: 'Poule 10' },
    { name: 'Poule 2' },
  ]);
  assert.equal(n.title, 'Poules modifiées · Fleuret hommes');
  assert.match(n.body, /^Poule 2 et Poule 10 ont changé/);
  assert.equal(n.url, '/?tournament=9&event=5&view=pools');
});

test('real FencingTimeLive page: swapping two fencers flags only their two pools', () => {
  const fs = require('node:fs');
  const { load } = require('cheerio');
  const { parsePools } = require('../src/services/ftlPools');
  const $ = load(fs.readFileSync(`${__dirname}/fixtures/ftl-pools.html`, 'utf8'));
  $('.poolScore').text('');
  $('.poolResult').text('');
  const parse = () =>
    $('table.poolTable')
      .toArray()
      .map((t) => parsePools($.html($(t).parent()))[0]);
  const before = parse();
  assert.equal(before.length, 28);
  assert.ok(
    before.every((p) => p.rows.every((r) => !r.firstResult && !r.hasResult)),
    'blank pools, before the start',
  );
  const pools = before.map((o) =>
    stored(
      o.number,
      o.rows.map((r) => r.name),
    ),
  );
  const everyone = before.flatMap((o) => o.rows.map((r) => ({ name: r.name })));
  assert.equal(planRecomposition(pools, URL_, parse(), everyone), null);
  const names = (n) =>
    $('table.poolTable')
      .eq(n - 1)
      .find('.poolCompName');
  const a = names(3).eq(1),
    b = names(5).eq(2),
    swap = a.text();
  a.text(b.text());
  b.text(swap);
  const plan = planRecomposition(pools, URL_, parse(), everyone);
  assert.deepEqual(
    plan.changed.map((x) => x.pool.name),
    ['Poule 3', 'Poule 5'],
  );
  assert.deepEqual([plan.added.length, plan.removed.length, plan.reordered.length], [0, 0, 0]);
});
