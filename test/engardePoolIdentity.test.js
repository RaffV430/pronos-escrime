const { test } = require('node:test');
const assert = require('node:assert/strict');
const { entryFor, overlapsPool } = require('../src/services/engardeRoster');
const { planRecomposition } = require('../src/services/poolRecompose');
const url = 'https://engarde-service.com/competition/demo/demo/demo/poules1.htm';
const roster = [
  { id: 'one', name: 'EXEMPLE Alex', country: 'CLUB A' },
  { id: 'two', name: 'EXEMPLE Alex', country: 'CLUB B' },
];
const observed = (number, club) => ({ number, rows: [{ name: 'EXEMPLE Alex', club, position: 1 }] });
const first = observed(18, 'CLUB A');
const second = observed(29, 'CLUB B');
const pool = {
  id: 1,
  sourceUrl: url,
  sourcePoolNumber: 18,
  fencers: [{ id: 100, name: 'EXEMPLE Alex', position: 1, wins: null, losses: null, indicator: null }],
};
const resolve = (entries, row) => entryFor(entries, row.name, row.club);

test('Engarde adds a pool with a club-disambiguated homonym without replacing the existing pool', () => {
  const before = JSON.stringify(pool);
  const plan = planRecomposition([pool], url, [first, second], roster, undefined, resolve);
  assert.equal(plan.changed.length, 0);
  assert.equal(plan.removed.length, 0);
  assert.deepEqual(plan.added, [second]);
  assert.equal(overlapsPool(pool, second, [first, second], roster, url), false);
  assert.equal(JSON.stringify(pool), before, 'existing fencer IDs and values remain untouched');
});

test('Engarde keeps protection against the same identity in two pools and uncertain correspondence', () => {
  assert.equal(overlapsPool(pool, observed(29, 'CLUB A'), [first], roster, url), true);
  assert.equal(overlapsPool(pool, second, [], roster, url), true);
  assert.equal(overlapsPool({ ...pool, sourceUrl: null }, second, [first], roster, url), true);
  assert.equal(overlapsPool(pool, observed(29, ''), [first], roster, url), true);
  assert.equal(overlapsPool(pool, second, [{ ...first, rows: [] }], roster, url), true);
  assert.throws(() => planRecomposition([pool], url, [first, observed(29, '')], roster, undefined, resolve), /ambigu/);
  assert.throws(() => planRecomposition([pool], url, [first, second], roster), /ambigu/, 'FTL default remains strict');
});

test('Engarde does not recompose a started pool even with resolved club identities', () => {
  assert.throws(
    () =>
      planRecomposition(
        [{ ...pool, isLocked: true }],
        url,
        [observed(18, 'CLUB B'), second].map((o) => ({ ...o, rows: [...o.rows, { name: 'OTHER', position: 2 }] })),
        [...roster, { id: 'other', name: 'OTHER' }],
        undefined,
        resolve,
      ),
    /après leur début/,
  );
});
