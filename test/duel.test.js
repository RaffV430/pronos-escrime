const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';
const { buildDuel } = require('../src/services/duel');

const m = (id, s1, s2, extra = {}) => ({
  id,
  player1: `A${id}`,
  player2: `B${id}`,
  round: 'T16',
  score1: s1,
  score2: s2,
  winner: s1 > s2 ? 1 : 2,
  resultType: 'NORMAL',
  competition: { name: 'Fleuret' },
  ...extra,
});
const p = (matchId, a, b, pts, bonus = 0) => ({
  matchId,
  predictedScore1: a,
  predictedScore2: b,
  pointsEarned: pts,
  bonusPoints: bonus,
});

test('match-by-match comparison with totals, bonus included, missing predictions shown', () => {
  const duel = buildDuel(
    [m(1, 15, 10), m(2, 8, 15), m(3, 15, 14), m(4, 15, 3)],
    [p(1, 15, 10, 4), p(2, 9, 15, 1, 1), p(3, 10, 15, 0)],
    [p(1, 15, 12, 1), p(2, 15, 9, 0), p(3, 15, 14, 4)],
  );
  assert.deepEqual(duel.totals, { me: 6, them: 5, won: 2, lost: 1, drawn: 0 });
  assert.deepEqual(
    duel.rows.map((r) => r.winner),
    ['me', 'me', 'them'],
  );
  assert.equal(duel.rows[1].me.points, 2, 'outsider bonus counted');
  const partial = buildDuel([m(1, 15, 10)], [p(1, 15, 10, 4)], []);
  assert.equal(partial.rows[0].them, null);
  assert.equal(buildDuel([m(1, 15, 10)], [], []).rows.length, 0, 'match nobody predicted is skipped');
});

test('GET duel: members only, another member only, finished non-cancelled matches of the league tournament', async (t) => {
  const league = { id: 3, name: 'Amis', tournamentId: 9, members: [{ userId: 1 }, { userId: 2 }] };
  let matchQuery;
  const db = {
    league: { findUnique: async () => league },
    match: { findMany: async (q) => ((matchQuery = q), [m(1, 15, 10)]) },
    prediction: { findMany: async ({ where }) => (where.userId === 1 ? [p(1, 15, 10, 4)] : [p(1, 10, 15, 0)]) },
    user: { findUnique: async () => ({ id: 2, name: 'Bob' }) },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const express = require('express');
  const app = express();
  app.use('/community', require('../src/routes/communityRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (path, userId) =>
    fetch(`http://127.0.0.1:${server.address().port}/community${path}`, {
      headers: { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` },
    });
  assert.equal((await get('/leagues/3/duel/2', 5)).status, 403, 'not a member');
  assert.equal((await get('/leagues/3/duel/7', 1)).status, 404, 'opponent outside the league');
  assert.equal((await get('/leagues/3/duel/1', 1)).status, 404, 'no duel with oneself');
  const res = await get('/leagues/3/duel/2', 1);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.opponent.name, 'Bob');
  assert.deepEqual(body.totals, { me: 4, them: 0, won: 1, lost: 0, drawn: 0 });
  assert.equal(matchQuery.where.isFinished, true);
  assert.equal(matchQuery.where.competition.tournamentId, 9);
  assert.deepEqual(matchQuery.where.OR, [{ resultType: null }, { resultType: { not: 'CANCELLED' } }]);
});
