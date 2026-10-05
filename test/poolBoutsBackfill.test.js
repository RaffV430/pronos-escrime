const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const E = require('../src/services/engardeParser');
const { parsePools } = require('../src/services/ftlPools');
const { backfillBouts } = require('../src/services/poolBoutsBackfill');

const FTL = 'https://www.fencingtimelive.com/pools/scores/' + 'a'.repeat(32) + '/' + 'b'.repeat(32);
const ENGARDE = 'https://engarde-service.com/competition/x/fdm20/poules.htm';
function fakeDb(pools) {
  const updates = [];
  return {
    updates,
    pool: {
      findMany: async () => pools,
      update: async ({ where, data }) => updates.push({ id: where.id, ...data }),
    },
  };
}
const poolsFrom = (observed, url, start = 1) =>
  observed.map((o, i) => ({
    id: start + i,
    name: `Poule ${o.number}`,
    sourceUrl: url,
    sourcePoolNumber: o.number,
    bouts: null,
    fencers: o.rows.map((r) => ({ name: r.name, position: r.position })),
  }));

test('relecture FencingTimeLive : seule la matrice est écrite', async () => {
  const html = fs.readFileSync(`${__dirname}/fixtures/cism-pools-corrected.html`, 'utf8');
  const observed = parsePools(html);
  const db = fakeDb(poolsFrom(observed, FTL));
  const s = await backfillBouts(db, 1, { ftlClient: { get: async () => html } });
  assert.equal(s.updated, observed.length);
  assert.deepEqual(Object.keys(db.updates[0]).sort(), ['bouts', 'id']);
  assert.deepEqual(db.updates[0].bouts, observed[0].bouts);
});

test('relecture engarde : composition différente laissée telle quelle', async () => {
  const html = fs.readFileSync(`${__dirname}/fixtures/engarde/fdm20-poules-1-2.html`, 'utf8');
  const observed = E.parsePools(html);
  const pools = poolsFrom(observed, ENGARDE);
  pools[1].fencers[0].name = 'AUTRE Tireuse';
  const db = fakeDb(pools);
  const s = await backfillBouts(db, 1, { engardeClient: { get: async () => html } });
  assert.equal(s.updated, 1);
  assert.equal(s.warnings.length, 1);
  assert.equal(db.updates[0].id, 1);
});
