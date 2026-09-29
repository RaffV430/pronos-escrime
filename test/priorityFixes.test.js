const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';
const { rescore } = require('../src/services/rescore');

test('rescore groups identical predictions into one write and counts only changed rows', async () => {
  const rows = [
    { id: 1, matchId: 5, predictedScore1: 15, predictedScore2: 8, pointsEarned: 0 },
    { id: 2, matchId: 5, predictedScore1: 15, predictedScore2: 8, pointsEarned: 0 },
    { id: 3, matchId: 5, predictedScore1: 15, predictedScore2: 10, pointsEarned: 1 },
    { id: 4, matchId: 5, predictedScore1: 8, predictedScore2: 15, pointsEarned: 0 },
    { id: 5, matchId: 6, predictedScore1: 15, predictedScore2: 8, pointsEarned: 0 },
  ];
  const calls = [];
  const model = {
    updateMany: async ({ where, data }) => {
      calls.push(where);
      const hit = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
  const score = (p) =>
    p.predictedScore1 === 15 && p.predictedScore2 === 8 ? 4 : p.predictedScore1 > p.predictedScore2 ? 1 : 0;
  const changed = await rescore(
    model,
    { matchId: 5 },
    rows.filter((r) => r.matchId === 5),
    ['predictedScore1', 'predictedScore2'],
    score,
  );
  assert.equal(changed, 2);
  assert.equal(calls.length, 1, 'unchanged groups are not rewritten');
  assert.deepEqual(
    rows.map((r) => r.pointsEarned),
    [4, 4, 1, 0, 0],
    'another match is never touched',
  );
});

test('a username equal to another player’s e-mail cannot intercept that player’s login', async (t) => {
  const hash = await bcrypt.hash('victim-password-123', 4);
  const users = [
    {
      id: 1,
      name: 'victim@example.com',
      email: 'attacker@example.com',
      password: await bcrypt.hash('attacker-pass-123', 4),
      isAdmin: false,
    },
    { id: 2, name: 'Victime', email: 'victim@example.com', password: hash, isAdmin: false },
    { id: 3, name: 'old@name', email: 'legacy@example.com', password: hash, isAdmin: false },
  ];
  const db = {
    user: {
      findUnique: async ({ where }) => users.find((u) => u.email === where.email) || null,
      findFirst: async ({ where }) => (where.OR ? null : users.find((u) => u.name === where.name) || null),
      create: async () => assert.fail('registration must be refused'),
    },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/authRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const victim = await post('/login', { email: 'Victim@example.com', password: 'victim-password-123' });
  assert.equal(victim.status, 200);
  assert.equal((await victim.json()).user.id, 2);
  const legacy = await post('/login', { email: 'old@name', password: 'victim-password-123' });
  assert.equal((await legacy.json()).user.id, 3, 'legacy names containing @ still log in');
  const refused = await post('/register', {
    username: 'someone@example.com',
    email: 'new@example.com',
    password: 'long-enough-pass',
  });
  assert.equal(refused.status, 400);
});

test('invalid numeric identifiers return 400 instead of a database error', async (t) => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const db = new Proxy(
    {},
    {
      get: (_, model) =>
        model === 'user'
          ? { findUnique: async () => ({ sessionVersion: 0 }) } // vérification de la session uniquement
          : new Proxy({}, { get: () => async () => assert.fail('no database call for an invalid id') }),
    },
  );
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  delete require.cache[require.resolve('../src/routes/matchRoutes')];
  delete require.cache[require.resolve('../src/routes/podiumRoutes')];
  const app = express();
  app.use(express.json());
  app.use('/matches', require('../src/routes/matchRoutes'));
  app.use('/podium', require('../src/routes/podiumRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const auth = { Authorization: `Bearer ${jwt.sign({ userId: 1, sv: 0 }, process.env.JWT_SECRET)}` };
  const call = (path, method = 'GET') =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: auth });
  for (const [path, method] of [
    ['/matches?competitionId=abc'],
    ['/matches/abc/predict', 'DELETE'],
    ['/matches/0/predict', 'DELETE'],
    ['/podium/competitions/x'],
    ['/podium/leaderboard/-1'],
    ['/podium/options/1.5'],
    ['/podium/abc'],
    ['/podium/competition-status/NaN'],
  ]) {
    assert.equal((await call(path, method)).status, 400, path);
  }
});
