const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';

test('login limits count failures per identifier, so a shared club wifi is not locked out', async (t) => {
  const hash = await bcrypt.hash('good-password-123', 4);
  const db = {
    user: {
      findUnique: async ({ where }) =>
        where.email === 'a@club.fr' ? { id: 1, name: 'A', email: 'a@club.fr', password: hash, isAdmin: false } : null,
      findFirst: async () => null,
    },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const express = require('express');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/auth', require('../src/routes/authRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const login = (email, password) =>
    fetch(`http://127.0.0.1:${server.address().port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  // 40 players of the same club log in successfully from one IP: none is blocked.
  for (let i = 0; i < 40; i++) assert.equal((await login('a@club.fr', 'good-password-123')).status, 200);
  // Brute force on one account is stopped after 10 failures…
  for (let i = 0; i < 10; i++) assert.equal((await login('a@club.fr', 'wrong-password')).status, 400);
  assert.equal((await login('a@club.fr', 'wrong-password')).status, 429);
  // …without blocking another player on the same network.
  assert.equal((await login('b@club.fr', 'whatever-123')).status, 400);
});

test('standings are cached briefly and recomputed after any change', async () => {
  const { standings, invalidateStandings } = require('../src/services/standings');
  let reads = 0;
  const db = {
    competition: { findMany: async () => [] },
    user: { findMany: async () => (reads++, [{ id: 1, name: 'A' }]) },
    podiumPrediction: { findMany: async () => [] },
    prediction: { findMany: async () => [] },
    poolPrediction: { findMany: async () => [] },
    pointAdjustment: { findMany: async () => [] },
    challenge: { findMany: async () => [] },
    match: { findMany: async () => [] },
  };
  await standings(db, { tournamentId: 1 });
  await standings(db, { tournamentId: 1 });
  assert.equal(reads, 1, 'second read served from cache');
  await standings(db, { tournamentId: 2 });
  assert.equal(reads, 2, 'another scope is computed separately');
  invalidateStandings();
  await standings(db, { tournamentId: 1 });
  assert.equal(reads, 3, 'recomputed after invalidation');
});
