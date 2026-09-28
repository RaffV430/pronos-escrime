const { test } = require('node:test');
const assert = require('node:assert/strict');
const { outsiderRule, crowdIsOutsider, applyOutsiderBonus } = require('../src/services/outsider');
const { summarizeCrowd } = require('../src/services/crowd');
const { standings } = require('../src/services/standings');

// n pronostics pour le tireur 1 (15-10) et m pour le tireur 2 (10-15).
const preds = (n, m) =>
  [...Array(n).fill([15, 10]), ...Array(m).fill([10, 15])].map(([a, b], i) => ({
    id: i + 1,
    userId: i + 1,
    matchId: 7,
    predictedScore1: a,
    predictedScore2: b,
    pointsEarned: 0,
    bonusPoints: 0,
  }));

test('bonus only below 25 % of at least 8 predictions, never on a medical withdrawal', () => {
  assert.equal(outsiderRule(preds(8, 2), 2, 'NORMAL').eligible, true, '20 %');
  assert.equal(outsiderRule(preds(6, 2), 2, 'NORMAL').eligible, false, 'exactly 25 % is not below a quarter');
  assert.equal(outsiderRule(preds(6, 1), 2, 'NORMAL').eligible, false, 'only 7 predictions');
  assert.equal(outsiderRule(preds(8, 2), 2, 'MEDICAL_WITHDRAWAL').eligible, false);
  assert.equal(outsiderRule(preds(8, 2), 2, 'CANCELLED').eligible, false);
  assert.equal(outsiderRule(preds(10, 0), 2, 'NORMAL').eligible, false, 'nobody to reward');
  assert.equal(outsiderRule(preds(8, 2), 1, 'NORMAL').eligible, false, 'the favourite won');
});

test('applied at result publication to the right players, removed if a correction makes the favourite win', async () => {
  const rows = preds(8, 2);
  const model = {
    updateMany: async ({ where, data }) => {
      const hit = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
  assert.equal(await applyOutsiderBonus(model, 7, rows, 2, 'NORMAL'), 2);
  assert.deepEqual(
    rows.map((r) => r.bonusPoints),
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
  );
  await applyOutsiderBonus(model, 7, rows, 1, 'NORMAL');
  assert.ok(rows.every((r) => r.bonusPoints === 0));
});

test('the displayed "outsider" flag follows the same rule as the points', () => {
  const crowd = (n, m) =>
    summarizeCrowd([
      { matchId: 7, predictedScore1: 15, predictedScore2: 10, _count: { _all: n } },
      { matchId: 7, predictedScore1: 10, predictedScore2: 15, _count: { _all: m } },
    ])[7];
  for (const [n, m, winner, type] of [
    [8, 2, 2, 'NORMAL'],
    [6, 2, 2, 'NORMAL'],
    [6, 1, 2, 'NORMAL'],
    [8, 2, 2, 'MEDICAL_WITHDRAWAL'],
    [9, 3, 2, 'NORMAL'],
    [30, 7, 2, 'NORMAL'],
  ])
    assert.equal(
      crowdIsOutsider(crowd(n, m), winner, type),
      outsiderRule(preds(n, m), winner, type).eligible,
      `${n}/${m}`,
    );
});

test('the bonus counts in the rankings', async () => {
  const db = {
    competition: { findMany: async () => [{ id: 1 }] },
    user: {
      findMany: async () => [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ],
    },
    podiumPrediction: { findMany: async () => [] },
    prediction: {
      findMany: async () => [
        { userId: 1, pointsEarned: 1, bonusPoints: 1 },
        { userId: 2, pointsEarned: 1, bonusPoints: 0 },
      ],
    },
    poolPrediction: { findMany: async () => [] },
    pointAdjustment: { findMany: async () => [] },
    challenge: { findMany: async () => [] },
    match: { findMany: async () => [] },
  };
  const rows = await standings(db, { competitionId: 1 });
  assert.deepEqual(
    rows.map((r) => [r.name, r.totalPoints, r.outsiderPoints, r.rank]),
    [
      ['A', 2, 1, 1],
      ['B', 1, 0, 2],
    ],
  );
});
