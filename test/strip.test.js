const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load } = require('cheerio');
const { parseTable } = require('../src/services/ftlParser');
const { parsePools, stripTime, applyPool } = require('../src/services/ftlPools');
const fixture = (name) => fs.readFileSync(`${__dirname}/fixtures/${name}`, 'utf8');
const roster = (html) => {
  const $ = load(html);
  return [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
};

test('tableau: strip read from FencingTimeLive, numbered or coloured', () => {
  const team = fixture('ftl-team.html');
  const t = parseTable(team, { date: '2026-09-27', roster: roster(team) });
  assert.deepEqual(
    t.matches.map((m) => m.strip),
    ['Blue', 'Yellow', 'Green', 'Red', '5', '6', '7', 'Yellow'],
  );
  const ind = fixture('ftl-individual-partial.html');
  const i = parseTable(ind, { date: '2026-09-27', roster: roster(ind), maxScore: 15, requireComplete: false });
  assert.ok(i.matches.filter((m) => m.strip).length > 5);
  assert.ok(i.matches.filter((m) => m.strip).every((m) => /^(\d+|Blue|Yellow|Green|Red)$/.test(m.strip)));
});

test('pools: strip and local time, never blocking when absent or unusual', () => {
  assert.deepEqual(stripTime('\n    On strip 10 at 9:00 AM\n'), { strip: '10', time: { hour: 9, minute: 0 } });
  assert.deepEqual(stripTime('On strip Red at 12:15 PM'), { strip: 'Red', time: { hour: 12, minute: 15 } });
  assert.deepEqual(stripTime('On strip 4'), { strip: '4', time: null });
  assert.deepEqual(stripTime(''), { strip: null, time: null });
  assert.deepEqual(stripTime('Piste à définir'), { strip: null, time: null });
  assert.deepEqual(stripTime('On strip 3 at 13:00 PM'), { strip: '3', time: null });
  const pools = parsePools(fixture('ftl-pools.html'));
  assert.deepEqual([pools[0].strip, pools[0].time], ['5', { hour: 9, minute: 0 }]);
  assert.equal(parsePools(fixture('ftl-pool-medical-withdrawal.html'))[0].strip, '4');
});

test('pools: strip and time are stored with the check, only when they change', async () => {
  const fencers = [
    { id: 1, name: 'A', position: 1 },
    { id: 2, name: 'B', position: 2 },
  ];
  const pool = { id: 3, name: 'Poule 1', lockMode: 'FIRST_RESULT', fencers, strip: null, startsAt: null };
  const updates = [];
  const tx = {
    $queryRaw: async () => [],
    pool: { findUnique: async () => pool, update: async ({ data }) => updates.push(data) },
    poolFencer: { updateMany: async () => ({ count: 1 }) },
    poolPrediction: { findMany: async () => [] },
  };
  const startsAt = new Date('2026-09-29T07:00:00Z');
  const observed = {
    complete: false,
    ambiguous: false,
    strip: '5',
    startsAt,
    rows: fencers.map((f) => ({ name: f.name, position: f.position })),
  };
  await applyPool(tx, pool, observed, new Date());
  assert.equal(updates[0].strip, '5');
  assert.equal(updates[0].startsAt, startsAt);
  await applyPool(tx, { ...pool }, { ...observed, strip: null, startsAt: null }, new Date());
  assert.ok(!('strip' in updates[1]) && !('startsAt' in updates[1]));
});
