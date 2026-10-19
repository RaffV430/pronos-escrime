const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const { latestControls, syncHealth } = require('../../src/services/syncHealth');
const skip = !url && 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('sync_health_reads');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('sync_health_reads');
});
after(async () => db?.$disconnect());
const targetId = 900001;
const control = 'Contrôle FTL terminé';
const configuration = 'Configuration FTL validée';
const rollback = new Error('rollback synthetic audit fixtures');
test('PostgreSQL suivi : derniers JSON seulement, avertissements et attente J2 identiques', { skip }, async () => {
  await assert.rejects(
    db.$transaction(
      async (tx) => {
        const create = (action, after, extra = {}) =>
          tx.auditLog.create({ data: { actorId: 0, targetType: 'Competition', targetId, action, after, ...extra } });
        await create(control, { warnings: ['ancien avertissement'], padding: 'x'.repeat(10000) });
        await create(configuration, {
          timezone: 'Europe/Paris',
          scheduleSessions: [{}, { date: '2026-10-20', time: '9:00 AM' }],
        });
        await create(control, { warnings: [] }, { createdAt: new Date('2000-01-01T00:00:00Z') });
        await create(control, { warnings: ['mauvais type'] }, { targetType: 'Other' });
        await create(control, { warnings: ['autre épreuve'] }, { targetId: targetId + 1 });
        const expected = await tx.auditLog.findMany({
          where: { targetType: 'Competition', targetId, action: { in: [control, configuration] } },
          orderBy: { id: 'desc' },
          distinct: ['targetId', 'action'],
          select: { targetId: true, action: true, after: true },
        });
        assert.deepEqual(await latestControls(tx, [targetId]), expected);
        assert.equal(expected.length, 2);
        const result = await syncHealth(
          {
            competition: {
              findMany: async () => [
                {
                  id: targetId,
                  name: 'TEST',
                  tournament: { name: 'TEST' },
                  pools: [{ isFinal: true }],
                  matches: [{ round: 'J1:T64', isFinished: true }],
                },
              ],
            },
            ftlSyncState: { findMany: async () => [{ competitionId: targetId, status: 'ATTENTION', failures: 0 }] },
            auditLog: tx.auditLog,
          },
          Date.parse('2026-10-19T12:00:00Z'),
        );
        assert.deepEqual(result.competitions[0].warnings, []);
        assert.equal(result.competitions[0].waitingForJ2.startsAt, '2026-10-20T07:00:00.000Z');
        await create(control, { warnings: ['nouveau contrôle'] });
        assert.deepEqual((await latestControls(tx, [targetId])).find((x) => x.action === control).after.warnings, [
          'nouveau contrôle',
        ]);
        throw rollback;
      },
      { timeout: 30000 },
    ),
    (error) => error === rollback,
  );
});
test('PostgreSQL suivi : absence de journal et annulation des fixtures', { skip }, async () => {
  assert.equal(await db.auditLog.count({ where: { targetId: { in: [targetId, targetId + 1] } } }), 0);
  assert.deepEqual(await latestControls(db, [targetId]), []);
});
