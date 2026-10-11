const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateMatchPoints, predictionText } = require('../src/services/matchPoints');
const { funTags, scoreGap } = require('../src/services/funFilters');
const { summarizeCrowd } = require('../src/services/crowd');
const { validatePrediction, poolPoints, comparison, poolPredictionText } = require('../src/services/poolRules');
const { checkSafety, statements } = require('../src/services/migrations');

test('a winner-only prediction earns the winner point but never the exact-score bonus', () => {
  assert.equal(calculateMatchPoints(1, 0, 15, 12, 1, 'NORMAL', true), 1);
  assert.equal(calculateMatchPoints(1, 0, 1, 0, 1, 'NORMAL', true), 1);
  assert.equal(calculateMatchPoints(1, 0, 1, 0, 1, 'NORMAL', false), 4);
  assert.equal(calculateMatchPoints(0, 1, 15, 12, 1, 'NORMAL', true), 0);
  assert.equal(calculateMatchPoints(0, 1, null, null, 2, 'MEDICAL_WITHDRAWAL', true), 1);
  const m = { player1: 'MARTIN Léa', player2: 'DURAND Chloé' };
  assert.equal(
    predictionText({ predictedScore1: 0, predictedScore2: 1, winnerOnly: true }, m),
    'Vainqueur : DURAND Chloé',
  );
  assert.equal(predictionText({ predictedScore1: 15, predictedScore2: 9 }, m), '15 – 9');
});

test('winner-only predictions keep the upset and one-touch tags, without score gaps', () => {
  const m = { isFinished: true, score1: 15, score2: 14, seed1: 20, seed2: 3, winner: 1 };
  const p = { predictedScore1: 1, predictedScore2: 0, winnerOnly: true };
  assert.deepEqual(funTags(p, m), ['poker', 'wire']);
  assert.deepEqual(funTags({ ...p, predictedScore1: 0, predictedScore2: 1 }, m), []);
  assert.equal(scoreGap(p, m), null);
});

test('crowd trends count winner-only picks but not as a predicted score', () => {
  const out = summarizeCrowd([
    { matchId: 1, predictedScore1: 1, predictedScore2: 0, winnerOnly: true, _count: { _all: 5 } },
    { matchId: 1, predictedScore1: 15, predictedScore2: 10, winnerOnly: false, _count: { _all: 2 } },
    { matchId: 1, predictedScore1: 8, predictedScore2: 15, winnerOnly: false, _count: { _all: 3 } },
  ]);
  assert.equal(out[1].total, 10);
  assert.equal(out[1].player1Pct, 70);
  assert.deepEqual(out[1].topScore, { score1: 8, score2: 15, count: 3 });
});

test('a pool prediction may give the wins only, which scores the wins only', () => {
  assert.deepEqual(validatePrediction({ wins: 3, losses: 2, indicator: null }, 6, { optionalIndicator: true }), {
    wins: 3,
    losses: 2,
    indicator: null,
  });
  assert.throws(() => validatePrediction({ wins: 3, losses: 2, indicator: null }, 6), /entiers/);
  assert.throws(() => validatePrediction({ wins: 3, losses: 1 }, 6, { optionalIndicator: true }), /égales à 5/);
  const result = { wins: 3, losses: 2, indicator: 4 };
  assert.deepEqual(poolPoints({ wins: 3, indicator: null }, result), { winsPoints: 3, indicatorPoints: 0, total: 3 });
  assert.equal(poolPoints({ wins: 3, indicator: 4 }, result).total, 8);
  // Match annulé : l'indice absent reste absent.
  assert.deepEqual(poolPoints({ wins: 3, indicator: null }, { wins: 3, losses: 1, indicator: 2 }, 6).adjusted, {
    wins: 3,
    indicator: null,
    annulled: 1,
  });
  const c = comparison({ wins: 3, losses: 2, indicator: null }, result, true, 6);
  assert.equal(c.indicatorCorrect, false);
  assert.equal(c.indicatorDifference, null);
  assert.equal(poolPredictionText({ wins: 3, indicator: null }), '3 V');
  assert.equal(poolPredictionText({ wins: 3, indicator: -2 }), '3 V · indice -2');
});

test('making a column optional is not treated as destructive', () => {
  const file = '202610112300_quick_predictions.sql';
  const sql = fs.readFileSync(path.join(__dirname, '../prisma/auto', file), 'utf8');
  assert.doesNotThrow(() => checkSafety(file, statements(sql), { PoolPrediction: ['indicator'] }));
  assert.throws(
    () => checkSafety('202610112301_x.sql', ['ALTER TABLE "Pool" DROP COLUMN "name"'], { Pool: ['name'] }),
    /destructive/,
  );
});
