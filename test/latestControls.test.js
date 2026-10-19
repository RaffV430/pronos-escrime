const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestControls, syncHealth } = require('../src/services/syncHealth');

test('dernier contrôle : aucune lecture quand aucune épreuve n’est suivie', async () => {
  assert.deepEqual(await latestControls({}, []), []);
  const result = await syncHealth({ competition: { findMany: async () => [] } });
  assert.deepEqual(result.competitions, []);
});
test('dernier contrôle : sélection des seuls identifiants maximum, filtres stricts et pas de JSON dans le groupement', async () => {
  let calls = 0;
  const result = await latestControls(
    {
      auditLog: {
        groupBy: async (q) => {
          assert.deepEqual(q, {
            by: ['targetId', 'action'],
            where: {
              action: { in: ['Contrôle FTL terminé', 'Configuration FTL validée'] },
              targetType: 'Competition',
              targetId: { in: [22, 23] },
            },
            _max: { id: true },
          });
          return [{ _max: { id: 100 } }, { _max: { id: 80 } }, { _max: { id: null } }];
        },
        findMany: async (q) => {
          calls++;
          assert.deepEqual(q.where.id.in, [100, 80]);
          assert.deepEqual(q.where.targetId.in, [22, 23]);
          assert.equal(q.distinct, undefined);
          assert.deepEqual(q.select, { targetId: true, action: true, after: true });
          return ['same latest controls'];
        },
      },
    },
    [22, 23],
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, ['same latest controls']);
});
test('dernier contrôle : aucun historique et erreur de groupement ne deviennent pas des succès silencieux', async () => {
  assert.deepEqual(await latestControls({ auditLog: { groupBy: async () => [] } }, [22]), []);
  await assert.rejects(
    latestControls(
      {
        auditLog: {
          groupBy: async () => {
            throw Error('database unavailable');
          },
        },
      },
      [22],
    ),
    /database unavailable/,
  );
});
