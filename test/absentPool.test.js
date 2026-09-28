const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { parsePools } = require('../src/services/ftlPools');
const html = fs.readFileSync(__dirname + '/fixtures/cism-pools-corrected.html', 'utf8');
test('official absence has no invented bouts, six active fencers remain complete', () => {
  const [one, seven] = parsePools(html);
  assert.equal(one.complete, true);
  assert.equal(one.rows.length, 6);
  assert.equal(seven.complete, true);
  assert.equal(seven.rows.length, 7);
  const absent = seven.rows[6];
  assert.equal(absent.absent, true);
  assert.equal(absent.hasResult, false);
  assert.equal(absent.firstResult, false);
  assert.equal(absent.wins, null);
  assert.equal(absent.indicator, null);
  assert.deepEqual(
    seven.rows.slice(0, 6).map((r) => [r.wins, r.losses, r.indicator]),
    [
      [3, 2, 5],
      [0, 5, -20],
      [4, 1, 4],
      [2, 3, 1],
      [3, 2, 8],
      [3, 2, 2],
    ],
  );
});
test('unrecognized absence and scores against absent fencer remain rejected', () => {
  assert.throws(() => parsePools(html.replace('Failed to Appear', 'Unknown withdrawal')));
  assert.throws(() => parsePools(html.replace('<td class="poolScoreWDX"></td>', '<td class="poolScoreWDX">V5</td>')));
});

test('official medical withdrawal (real FencingTimeLive pool): his bouts are annulled, the others are verified without him', () => {
  const [pool] = parsePools(fs.readFileSync(__dirname + '/fixtures/ftl-pool-medical-withdrawal.html', 'utf8'));
  assert.equal(pool.number, 4);
  assert.equal(pool.complete, true);
  const out = pool.rows[6];
  assert.deepEqual(
    [out.name, out.absent, out.status, out.wins, out.indicator, out.firstResult],
    ['RADNOTI Zeno', true, 'Medical Withdrawal', null, null, false],
  );
  assert.deepEqual(
    pool.rows.slice(0, 6).map((r) => [r.wins, r.losses, r.indicator]),
    [
      [1, 4, -4],
      [4, 1, 9],
      [5, 0, 8],
      [1, 4, -12],
      [1, 4, -8],
      [3, 2, 7],
    ],
  );
  // Libellé inconnu : toujours refusé plutôt que deviné.
  assert.throws(() =>
    parsePools(
      fs
        .readFileSync(__dirname + '/fixtures/ftl-pool-medical-withdrawal.html', 'utf8')
        .replace('Medical Withdrawal', 'Excluded'),
    ),
  );
});

test('a withdrawal after a first result clears the provisional record and keeps the individual lock', async () => {
  const { applyPool } = require('../src/services/ftlPools');
  const locked = new Date('2026-10-10T08:00:00Z');
  const fencers = [
    { id: 1, name: 'A', position: 1, wins: 1, losses: 0, indicator: 3, firstResultAt: locked },
    { id: 2, name: 'B', position: 2, wins: 1, losses: 0, indicator: 2, firstResultAt: locked },
    { id: 3, name: 'C', position: 3, wins: 0, losses: 2, indicator: -5, firstResultAt: locked },
  ];
  const pool = {
    id: 9,
    competitionId: 1,
    sourceUrl: 'u',
    sourcePoolNumber: 1,
    lockMode: 'FIRST_RESULT',
    isLocked: false,
    isFinal: false,
    name: 'Poule 1',
    fencers,
  };
  const updates = [];
  const tx = {
    $queryRaw: async () => [],
    pool: { findUnique: async () => pool, update: async () => pool },
    poolFencer: { updateMany: async ({ where, data }) => (updates.push([where.id, data]), { count: 1 }) },
    poolPrediction: { findMany: async () => [] },
  };
  const observed = {
    complete: false,
    ambiguous: false,
    rows: [
      { name: 'A', position: 1, firstResult: true, hasResult: true, wins: 1, losses: 0, indicator: 3 },
      { name: 'B', position: 2, firstResult: true, hasResult: true, wins: 0, losses: 0, indicator: 0 },
      {
        name: 'C',
        position: 3,
        firstResult: false,
        hasResult: false,
        absent: true,
        status: 'Medical Withdrawal',
        wins: null,
        losses: null,
        indicator: null,
      },
    ],
  };
  await applyPool(tx, pool, observed, new Date());
  assert.deepEqual(updates.find(([id]) => id === 3)[1], { wins: null, losses: null, indicator: null });
  assert.ok(!('firstResultAt' in updates.find(([id]) => id === 3)[1]), 'the individual lock stays');
});
