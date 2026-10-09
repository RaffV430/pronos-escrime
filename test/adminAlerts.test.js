const test = require('node:test');
const assert = require('node:assert/strict');
const { summary } = require('../src/services/adminAlerts');
test('badge counts all pending clubs and unresolved active event failures, then clears', async () => {
  let pending = 2,
    states = [
      { competitionId: 10, status: 'ERROR', failures: 3 },
      { competitionId: 11, status: 'ATTENTION' },
    ];
  const db = {
    clubRegistrationRequest: {
      count: async ({ where }) => {
        assert.deepEqual(where, { status: 'PENDING' });
        return pending;
      },
    },
    competition: {
      findMany: async ({ where }) => {
        assert.deepEqual(where.tournament, { archivedAt: null });
        return [{ id: 10 }, { id: 11 }];
      },
    },
    ftlSyncState: { findMany: async () => states },
  };
  assert.deepEqual(await summary(db), { clubs: 2, problems: 2, total: 4 });
  pending = 0;
  states = [
    { competitionId: 10, status: 'OK' },
    { competitionId: 11, status: 'COMPLETE' },
  ];
  assert.equal((await summary(db)).total, 0);
});
