const { test } = require('node:test');
const assert = require('node:assert/strict');
const { poolPoints, adjustForAnnulled, comparison } = require('../src/services/poolRules');

// Poule de 7 avec un absent : 5 matchs tirés par tireur.
const real = (wins, indicator, bouts = 5) => ({ wins, losses: bouts - wins, indicator });
const pick = (wins, indicator, size = 7) => ({ wins, losses: size - 1 - wins, indicator });

test('rule agreed with the maître d’armes: examples of the confirmation table', () => {
  const r = real(5, 17);
  assert.deepEqual(adjustForAnnulled(pick(6, 22), r, 7), { wins: 5, indicator: 17, annulled: 1 });
  assert.deepEqual(adjustForAnnulled(pick(4, 8), r, 7), { wins: 4, indicator: 3, annulled: 1 });
  assert.deepEqual(adjustForAnnulled(pick(3, 0), r, 7), { wins: 3, indicator: -5, annulled: 1 });
  assert.deepEqual(adjustForAnnulled(pick(2, -6), r, 7), { wins: 2, indicator: -1, annulled: 1 });
  assert.deepEqual(adjustForAnnulled(pick(0, -24), r, 7), { wins: 0, indicator: -19, annulled: 1 });
});

test('undefeated prediction becomes exact again when the fencer wins all fenced bouts', () => {
  const p = poolPoints(pick(6, 22), real(5, 17), 7);
  assert.deepEqual([p.winsPoints, p.indicatorPoints, p.total], [3, 5, 8]);
  assert.equal(poolPoints(pick(6, 22), real(5, 17)).total, 2, 'without the pool size: old behaviour (1 + 1)');
});

test('exact half counts as "at least half" (pool of 6 with one absent: 2 V out of 4 → −5)', () => {
  assert.deepEqual(adjustForAnnulled(pick(2, 3, 6), real(2, -2, 4), 6), { wins: 2, indicator: -2, annulled: 1 });
  assert.deepEqual(adjustForAnnulled(pick(1, -8, 6), real(1, -3, 4), 6), { wins: 1, indicator: -3, annulled: 1 });
});

test('two absents: the rule applies once per annulled bout (wins capped, indicator ±10)', () => {
  assert.deepEqual(adjustForAnnulled(pick(6, 25), real(4, 15, 4), 7), { wins: 4, indicator: 15, annulled: 2 });
  assert.deepEqual(adjustForAnnulled(pick(1, -20), real(1, -10, 4), 7), { wins: 1, indicator: -10, annulled: 2 });
});

test('complete pools, absents themselves and unknown sizes are untouched', () => {
  assert.equal(adjustForAnnulled(pick(4, 8), real(4, 8, 6), 7), null);
  assert.equal(adjustForAnnulled(pick(4, 8), { wins: null, losses: null, indicator: null }, 7), null);
  assert.equal(adjustForAnnulled(pick(4, 8), real(4, 8), null), null);
  assert.equal(poolPoints(pick(4, 8), real(4, 8, 6), 7).adjusted, undefined);
});

test('comparison flags correctness on the adjusted values', () => {
  const c = comparison(pick(6, 22), real(5, 17), true, 7);
  assert.equal(c.winsCorrect, true);
  assert.equal(c.indicatorCorrect, true);
  assert.deepEqual(c.points.adjusted, { wins: 5, indicator: 17, annulled: 1 });
});

test('real FencingTimeLive pool with a medical withdrawal: FTL import scores with the adjustment', async () => {
  const fs = require('node:fs');
  const { parsePools, applyPool } = require('../src/services/ftlPools');
  const [observed] = parsePools(fs.readFileSync(`${__dirname}/fixtures/ftl-pool-medical-withdrawal.html`, 'utf8'));
  const fencers = observed.rows.map((r, i) => ({
    id: i + 1,
    name: r.name,
    position: r.position,
    wins: null,
    losses: null,
    indicator: null,
    firstResultAt: new Date(),
  }));
  const pool = {
    id: 4,
    competitionId: 1,
    sourceUrl: 'u',
    sourcePoolNumber: 4,
    lockMode: 'FIRST_RESULT',
    isLocked: false,
    isFinal: false,
    name: 'Poule 4',
    fencers,
  };
  // MAW : 5 V / 0 D, +8 réel. Pronostic 6 V · +13 → comparé à 5 V · +8 → 8 points.
  const predictions = [
    { id: 1, userId: 1, fencerId: 3, wins: 6, losses: 0, indicator: 13, pointsEarned: 0 },
    { id: 2, userId: 2, fencerId: 7, wins: 3, losses: 3, indicator: 0, pointsEarned: 0 }, // sur le blessé
  ];
  const tx = {
    $queryRaw: async () => [],
    pool: { findUnique: async () => pool, update: async () => pool },
    poolFencer: { updateMany: async () => ({ count: 1 }) },
    poolPrediction: {
      findMany: async () => predictions,
      updateMany: async ({ where, data }) => {
        const hit = predictions.filter((p) => Object.entries(where).every(([k, v]) => p[k] === v));
        hit.forEach((p) => Object.assign(p, data));
        return { count: hit.length };
      },
    },
  };
  await applyPool(tx, pool, observed, new Date());
  assert.equal(predictions[0].pointsEarned, 8);
  assert.equal(predictions[1].pointsEarned, 0, 'the withdrawn fencer scores nothing');
});
