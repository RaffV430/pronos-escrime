const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncHealth } = require('../src/services/syncHealth');
test('administration : détails du dernier contrôle seulement, sans écriture ni envoi', async () => {
  let rows = [{ targetId: 20, after: { warnings: ['Identité officielle ambiguë', 'Identité officielle ambiguë'] } }];
  const db = {
    competition: { findMany: async () => [{ id: 20, name: 'TEST', tournament: { name: 'TEST' } }] },
    ftlSyncState: { findMany: async () => [{ competitionId: 20, status: 'ATTENTION', failures: 0, lastError: null }] },
    auditLog: {
      findMany: async (q) => {
        assert.equal(q.where.action, 'Contrôle FTL terminé');
        assert.deepEqual(q.distinct, ['targetId']);
        return rows;
      },
    },
  };
  let result = await syncHealth(db);
  assert.equal(result.summary.warning, 1);
  assert.deepEqual(result.competitions[0].warnings, ['Identité officielle ambiguë']);
  rows = [{ targetId: 20, after: { warnings: [] } }];
  result = await syncHealth(db);
  assert.deepEqual(result.competitions[0].warnings, []);
  rows = [];
  assert.deepEqual((await syncHealth(db)).competitions[0].warnings, []);
});
