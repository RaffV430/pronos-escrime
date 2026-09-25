const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePrediction, validateResults, closed, comparison, poolPoints, id } = require('../src/services/poolRules');

test('pool predictions accept zero wins and negative indicators; reject empty or impossible values', () => {
  assert.deepEqual(validatePrediction({ wins: 0, losses: 6, indicator: -30 }, 7), { wins: 0, losses: 6, indicator: -30 });
  assert.deepEqual(validatePrediction({ wins: 6, losses: 0, indicator: 30 }, 7), { wins: 6, losses: 0, indicator: 30 });
  for (const value of [null, { wins: '', losses: 6, indicator: 0 }, { wins: 1.5, losses: 4.5, indicator: 0 }, { wins: 3, losses: 2, indicator: 0 }, { wins: 6, losses: 0, indicator: 0 }, { wins: 0, losses: 6, indicator: 1 }, { wins: -1, losses: 7, indicator: 0 }]) assert.throws(() => validatePrediction(value, 7));
});
test('score tiers are exclusive, symmetric, and include boundaries', () => {
  const result = { wins: 3, losses: 3, indicator: 0 };
  for (const sign of [-1, 1]) {
    for (const [gap, points] of [[0,5],[1,3],[3,3],[4,1],[5,1],[6,0]]) {
      assert.deepEqual(poolPoints({ wins: 3, indicator: sign * gap }, result), { winsPoints: 3, indicatorPoints: points, total: 3 + points });
    }
    assert.equal(poolPoints({ wins: 3 + sign, indicator: 6 }, result).total, 1);
    assert.equal(poolPoints({ wins: 3 + 2 * sign, indicator: 6 }, result).total, 0);
  }
});
test('no comparison until results are final, and losses add no points', () => {
  const p = { wins: 2, losses: 4, indicator: -1 };
  assert.equal(comparison(p, p, false), null);
  assert.equal(comparison(null, p, true), null);
  assert.equal(comparison(p, p, true).points.total, 8);
  assert.equal(poolPoints({ ...p, losses: 0 }, p).total, 8);
});
test('closes exactly at deadline and remains closed after finalization', () => {
  const pool = { closesAt: '2026-09-26T07:00:00Z', isLocked: false, isFinal: false };
  assert.equal(closed(pool, new Date('2026-09-26T06:59:59Z')), false);
  assert.equal(closed(pool, new Date(pool.closesAt)), true);
  assert.equal(closed({ ...pool, isLocked: true }, new Date('2026-09-25')), true);
  assert.equal(closed({ ...pool, isFinal: true }, new Date('2026-09-25')), true);
});
test('official results require complete, unique, internally consistent rows', () => {
  const fencers = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const rows = [{ fencerId: 1, wins: 2, losses: 0, indicator: 6 }, { fencerId: 2, wins: 1, losses: 1, indicator: 0 }, { fencerId: 3, wins: 0, losses: 2, indicator: -6 }];
  assert.equal(validateResults(rows, fencers).length, 3);
  assert.throws(() => validateResults(rows.slice(1), fencers));
  assert.throws(() => validateResults([rows[0], rows[0], rows[2]], fencers));
  assert.throws(() => validateResults([...rows.slice(0,2), { ...rows[2], indicator: -5 }], fencers));
  assert.throws(() => validateResults(rows.map(r => ({ ...r, wins: 2, losses: 0, indicator: 3 })), fencers));
});
test('ids do not accept permissive parseInt values or coercion', () => {
  assert.equal(id('123'), 123);
  for (const value of ['1bad', '', true, null, -1, 1.2, 2147483648]) assert.throws(() => id(value));
});
