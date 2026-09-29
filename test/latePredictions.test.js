const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createPoolRouter } = require('../src/routes/poolRoutes');
process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';

test('admin fairness check lists predictions saved just before each fencer was locked', async (t) => {
  const lock = new Date('2026-09-29T08:17:48Z');
  const at = (s) => new Date(lock.getTime() - s * 1000);
  const pool = {
    id: 2,
    name: 'Poule 2',
    fencers: [
      {
        id: 10,
        name: 'ROGER WALLERAND',
        position: 4,
        firstResultAt: lock,
        predictions: [
          { id: 1, userId: 5, user: { name: 'Léa' }, updatedAt: at(40), wins: 6, indicator: 15, pointsEarned: 8 },
          { id: 2, userId: 6, user: { name: 'Tom' }, updatedAt: at(3600), wins: 4, indicator: 5, pointsEarned: 3 },
        ],
      },
      { id: 11, name: 'DOSA DANIEL', position: 3, firstResultAt: null, predictions: [] },
    ],
  };
  const db = {
    user: { findUnique: async ({ where }) => ({ isAdmin: where.id === 1, sessionVersion: 0 }) },
    pool: { findUnique: async () => pool },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const app = express();
  app.use('/pools', createPoolRouter(db, { sourceCheck: async () => null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (userId) =>
    fetch(`http://127.0.0.1:${server.address().port}/pools/2/late-predictions`, {
      headers: { Authorization: `Bearer ${jwt.sign({ userId, sv: 0 }, process.env.JWT_SECRET)}` },
    });
  assert.equal((await get(2)).status, 403);
  const body = await (await get(1)).json();
  assert.deepEqual(
    body.rows.map((r) => [r.player, r.fencer, r.secondsBeforeLock]),
    [['Léa', 'ROGER WALLERAND', 40]],
  );
});
