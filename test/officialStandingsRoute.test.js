const { test } = require('node:test');
const assert = require('node:assert/strict');
test('public sporting standings are read-only, omit predictions and reject unknown events', async (t) => {
  const db = {
    competition: {
      findUnique: async ({ where }) =>
        where.id === 1
          ? {
              id: 1,
              podiumRoster: [{ id: 'a', name: 'TEST Alex', club: 'CLUB A' }],
              resultsVerifiedAt: new Date('2026-10-18'),
              resultsSourceUrl: 'https://engarde-service.com/competition/test/event/main/clasfinal.htm',
              officialPodium: { finalConfirmed: true, classification: [{ entryId: 'a', rank: 1 }] },
              predictions: [{ userId: 99, pointsEarned: 45 }],
            }
          : null,
    },
    pool: { findMany: async () => [] },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const app = require('express')();
  app.use('/public', require('../src/routes/publicRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const root = `http://127.0.0.1:${server.address().port}/public/competitions`;
  const response = await fetch(`${root}/1/standings`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.standings[0].rows[0].name, 'TEST Alex');
  assert.doesNotMatch(JSON.stringify(body), /userId|pointsEarned|predictions/);
  assert.equal((await fetch(`${root}/999/standings`)).status, 404);
  assert.equal((await fetch(`${root}/invalid/standings`)).status, 400);
});
