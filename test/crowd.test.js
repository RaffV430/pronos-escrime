const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeCrowd, crowdFor } = require('../src/services/crowd');

const row = (matchId, a, b, n) => ({ matchId, predictedScore1: a, predictedScore2: b, _count: { _all: n } });

test('crowd trends give winner shares and the most played score per match', () => {
  const out = summarizeCrowd([row(1, 15, 10, 5), row(1, 15, 12, 2), row(1, 8, 15, 3), row(2, 3, 15, 1)]);
  assert.deepEqual(out[1], {
    total: 10,
    player1Pct: 70,
    player2Pct: 30,
    topScore: { score1: 15, score2: 10, count: 5 },
  });
  assert.deepEqual(out[2], { total: 1, player1Pct: 0, player2Pct: 100, topScore: { score1: 3, score2: 15, count: 1 } });
  const tie = summarizeCrowd([row(3, 15, 9, 2), row(3, 10, 15, 2)]);
  assert.equal(tie[3].topScore.score1, 10, 'ties are resolved deterministically');
});

test('no query at all when no match is closed', async () => {
  const db = { prediction: { groupBy: async () => assert.fail('must not read predictions of open matches') } };
  assert.deepEqual(await crowdFor(db, []), {});
});
