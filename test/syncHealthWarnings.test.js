const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncHealth } = require('../src/services/syncHealth');
test('administration : détails du dernier contrôle seulement, sans écriture ni envoi', async () => {
  let rows = [{ targetId: 20, after: { warnings: ['Identité officielle ambiguë', 'Identité officielle ambiguë'] } }];
  const db = {
    competition: { findMany: async () => [{ id: 20, name: 'TEST', tournament: { name: 'TEST' } }] },
    ftlSyncState: { findMany: async () => [{ competitionId: 20, status: 'ATTENTION', failures: 0, lastError: null }] },
    auditLog: {
      groupBy: async (q) => {
        assert.deepEqual(q.by, ['targetId', 'action']);
        assert.deepEqual(q._max, { id: true });
        return rows.map((_, i) => ({ _max: { id: i + 1 } }));
      },
      findMany: async (q) => {
        assert.deepEqual(q.where.action.in, ['Contrôle FTL terminé', 'Configuration FTL validée']);
        assert.equal(q.distinct, undefined);
        assert.deepEqual(
          q.where.id.in,
          rows.map((_, i) => i + 1),
        );
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
