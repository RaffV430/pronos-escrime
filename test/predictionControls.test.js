const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';
let locked = false;
const match = {
  id: 1,
  competitionId: 1,
  round: 'T128',
  startsAt: new Date(Date.now() - 3600000),
  player1: 'Alice',
  player2: 'Bob',
  isFinished: false,
  isLocked: false,
};
const competition = {
  id: 1,
  isPodiumLocked: true,
  podiumFormat: 'INDIVIDUAL',
  podiumRoster: ['A', 'B', 'C', 'D'].map((id) => ({ id, name: id, country: 'FRA' })),
};
const picks = [
  { id: 1, matchId: 1, predictedScore1: 15, predictedScore2: 8, pointsEarned: 4 },
  { id: 2, matchId: 1, predictedScore1: 8, predictedScore2: 15, pointsEarned: 0 },
];
const config = { competitionId: 1, round: 'T128', previousRound: null, expectedMatchCount: 1, manualUnlockUntil: null };
const db = {
  matchRound: {
    findMany: async () => [config],
    findUnique: async () => config,
    update: async ({ data }) => Object.assign(config, data),
  },
  $queryRaw: async () => {
    locked = true;
    return [{ id: 1 }];
  },
  match: {
    count: async () => (match.isFinished ? 0 : 1),
    findUnique: async () => match,
    findMany: async () => [match],
    update: async ({ data }) => {
      assert.ok(locked);
      return Object.assign(match, data);
    },
  },
  competition: {
    findUnique: async () => competition,
    update: async ({ data }) => {
      assert.ok(locked);
      return Object.assign(competition, data);
    },
  },
  podiumPrediction: {
    upsert: async ({ create }) => {
      assert.ok(locked);
      return create;
    },
  },
  prediction: {
    upsert: async ({ create }) => {
      assert.ok(locked);
      return create;
    },
    deleteMany: async () => {
      assert.ok(locked);
    },
    findMany: async () => picks,
    update: async ({ where, data }) =>
      Object.assign(
        picks.find((p) => p.id === where.id),
        data,
      ),
    groupBy: async () =>
      picks.map((p) => ({
        matchId: p.matchId,
        predictedScore1: p.predictedScore1,
        predictedScore2: p.predictedScore2,
        _count: { _all: 1 },
      })),
    updateMany: async ({ where, data }) => {
      const rows = picks.filter((p) => Object.entries(where).every(([k, v]) => p[k] === v));
      rows.forEach((p) => Object.assign(p, data));
      return { count: rows.length };
    },
  },
  user: {
    findUnique: async ({ where }) => ({ isAdmin: where.id === 2 }),
    findFirst: async ({ where }) => {
      assert.equal(where.OR[0].email.mode, 'insensitive');
      assert.equal(where.OR[1].name.mode, 'insensitive');
      return { id: 1 };
    },
    findMany: async ({ where }) => (where.name?.equals === 'Alice' ? [{ id: 7, name: 'Alice' }] : []),
    create: async () => {
      throw { code: 'P2002' };
    },
  },
  auditLog: { create: async ({ data }) => data },
  pointAdjustment: { findUnique: async () => null, create: async ({ data }) => data },
};
db.$transaction = async (fn) => {
  locked = false;
  return fn(db);
};
require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
const { app } = require('../src/server');
test('HTTP admin reopen, podium persistence, medical closure, registration conflicts and points by name', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const request = async (path, method = 'GET', body, admin = false) =>
    fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.sign({ userId: admin ? 2 : 1, isAdmin: false, sv: 0 }, process.env.JWT_SECRET)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await request('/matches/1/predict', 'POST', { predictedScore1: 15, predictedScore2: 8 })).status, 409);
  assert.equal((await request('/matches/sync-ftl', 'POST', { competitionId: 1 })).status, 403);
  assert.equal((await request('/matches/sync-ftl/1')).status, 403);
  assert.equal((await request('/matches/sync-ftl', 'POST', { competitionId: 0 }, true)).status, 400);
  assert.equal((await request('/matches/1/lock', 'PUT', { isLocked: false })).status, 403);
  assert.equal((await request('/matches/1/lock', 'PUT', { isLocked: false }, true)).status, 400);
  assert.equal((await request('/matches/rounds/1/T128/unlock', 'PUT', {})).status, 403);
  assert.equal((await request('/matches/rounds/1/T128/unlock', 'PUT', {}, true)).status, 200);
  assert.ok(config.manualUnlockUntil > Date.now());
  assert.equal((await request('/matches/1/predict', 'POST', { predictedScore1: 15, predictedScore2: 8 })).status, 200);
  assert.equal((await request('/matches/1/predict', 'DELETE')).status, 200);
  for (const [a, b] of [
    [16, 1],
    [15, 15],
    [null, 3],
    ['15', 3],
    [true, 3],
    [1.5, 3],
  ])
    assert.equal((await request('/matches/1/predict', 'POST', { predictedScore1: a, predictedScore2: b })).status, 400);
  competition.podiumFormat = 'TEAM';
  assert.equal((await request('/matches/1/predict', 'POST', { predictedScore1: 45, predictedScore2: 44 })).status, 200);
  assert.equal((await request('/matches/1/predict', 'POST', { predictedScore1: 46, predictedScore2: 44 })).status, 400);
  competition.podiumFormat = 'INDIVIDUAL';
  config.manualUnlockUntil = new Date(Date.now() - 1);
  assert.equal((await request('/matches/1/predict', 'POST', { predictedScore1: 15, predictedScore2: 8 })).status, 409);
  assert.equal((await request('/matches/1/predict', 'DELETE')).status, 409);
  const closedList = await (await request('/matches?competitionId=1')).json();
  assert.equal(closedList[0].isClosed, true);
  assert.deepEqual(closedList[0].crowd, {
    total: 2,
    player1Pct: 50,
    player2Pct: 50,
    topScore: { score1: 15, score2: 8, count: 1 },
    outsider: false,
  });
  assert.equal((await request('/matches/rounds/1/T128/unlock', 'PUT', {}, true)).status, 200);

  assert.equal((await request('/podium/competition/1/toggle-lock', 'PUT', { isLocked: 'false' }, true)).status, 400);
  assert.equal((await request('/podium/competition/1/toggle-lock', 'PUT', { isLocked: false }, true)).status, 200);
  assert.equal((await (await request('/podium/competition-status/1')).json()).isLocked, false);
  assert.equal(
    (
      await request('/podium', 'POST', {
        competitionId: 1,
        selectionIds: { gold: 'A', silver: 'B', bronze1: 'C', bronze2: 'D' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        '/podium/competition/1/resolve',
        'POST',
        { gold: 'A', silver: 'B', bronze1: 'C', bronze2: 'D' },
        true,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request('/podium', 'POST', { competitionId: 1, gold: 'A', silver: 'B', bronze1: 'C', bronze2: 'D' })).status,
    400,
  );
  assert.equal((await request('/matches/1/medical-withdrawal', 'PUT', { winner: 2 })).status, 403);
  assert.equal((await request('/matches/1/medical-withdrawal', 'PUT', { winner: 2 }, true)).status, 200);
  assert.equal(match.isFinished, true);
  assert.equal(match.score1, null);
  assert.equal(match.winner, 2);
  assert.deepEqual(
    picks.map((p) => p.pointsEarned),
    [0, 1],
  );
  await request('/matches/1/medical-withdrawal', 'PUT', { winner: 2 }, true);
  assert.deepEqual(
    picks.map((p) => p.pointsEarned),
    [0, 1],
  );
  assert.equal((await request('/matches/rounds/1/T128/unlock', 'PUT', {}, true)).status, 409);
  assert.equal((await request('/matches/1/predict', 'DELETE')).status, 409);
  competition.podiumResolvedAt = new Date();
  assert.equal((await request('/podium/competition/1/toggle-lock', 'PUT', { isLocked: false }, true)).status, 409);
  assert.equal((await (await request('/podium/competition-status/1')).json()).isLocked, true);

  assert.equal(
    (
      await request('/auth/register', 'POST', {
        username: 'ALICE',
        email: 'Alice@example.com',
        password: 'test-password-long',
      })
    ).status,
    400,
  );
  db.user.findFirst = async () => null;
  assert.equal(
    (
      await request('/auth/register', 'POST', {
        username: 'ALICE',
        email: 'Alice@example.com',
        password: 'test-password-long',
      })
    ).status,
    409,
  );
  const adjustment = await request(
    '/admin/adjust-points',
    'POST',
    { name: 'Alice', points: 3, reason: 'Test ajustement', requestKey: 'test-key-123456789' },
    true,
  );
  assert.equal(adjustment.status, 200);
  assert.equal((await adjustment.json()).adjustment.userId, 7);
  assert.equal(
    (
      await request(
        '/admin/adjust-points',
        'POST',
        { name: 'Unknown', points: 3, reason: 'Test ajustement', requestKey: 'test-key-123456789' },
        true,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        '/admin/adjust-points',
        'POST',
        { name: 'Alice', userId: 7, points: 3, reason: 'Test ajustement', requestKey: 'test-key-123456789' },
        true,
      )
    ).status,
    400,
  );
});
