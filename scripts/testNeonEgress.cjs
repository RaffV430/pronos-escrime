const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { latestControls, syncHealth } = require('../src/services/syncHealth');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(config.branchId, 'br-patient-tooth-b1ke6ifq');
assert.equal(new URL(config.url).hostname, 'ep-summer-leaf-b1rznai6-pooler.c-5.eu-central-1.aws.neon.tech');
const db = new PrismaClient({ datasources: { db: { url: config.url } } });
after(() => db.$disconnect());
const rollback = new Error('rollback test-only audit fixtures');
const targetId = -900001;
const control = 'Contrôle FTL terminé';
const configuration = 'Configuration FTL validée';
test('PostgreSQL isolé : dernier id, pas dernière date ; JSON ancien exclu, warning effacé et config conservée', async () => {
  await assert.rejects(
    db.$transaction(
      async (tx) => {
        const create = (action, after, extra = {}) =>
          tx.auditLog.create({ data: { actorId: 0, targetType: 'Competition', targetId, action, after, ...extra } });
        await create(control, { warnings: ['ancien avertissement'], padding: 'x'.repeat(100000) });
        await create(configuration, {
          timezone: 'Europe/Paris',
          scheduleSessions: [{}, { date: '2026-10-20', time: '9:00 AM' }],
        });
        await create(control, { warnings: [] }, { createdAt: new Date('2000-01-01T00:00:00Z') });
        await create(control, { warnings: ['mauvais type'] }, { targetType: 'Other' });
        await create(control, { warnings: ['autre épreuve'] }, { targetId: targetId - 1 });
        const expected = await tx.auditLog.findMany({
          where: { targetType: 'Competition', targetId, action: { in: [control, configuration] } },
          orderBy: { id: 'desc' },
          distinct: ['targetId', 'action'],
          select: { targetId: true, action: true, after: true },
        });
        const actual = await latestControls(tx, [targetId]);
        assert.deepEqual(actual, expected);
        assert.equal(actual.length, 2);
        assert.deepEqual(actual.find((x) => x.action === control).after, { warnings: [] });
        const response = await syncHealth(
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
        assert.deepEqual(response.competitions[0].warnings, []);
        assert.equal(response.competitions[0].waitingForJ2.startsAt, '2026-10-20T07:00:00.000Z');
        assert.equal(response.competitions[0].waitingForJ2.timezone, 'Europe/Paris');
        await create(control, { warnings: ['nouveau contrôle'] });
        const refreshed = await latestControls(tx, [targetId]);
        assert.deepEqual(refreshed.find((x) => x.action === control).after.warnings, ['nouveau contrôle']);
        throw rollback;
      },
      { timeout: 30000 },
    ),
    (error) => error === rollback,
  );
});
test('PostgreSQL isolé : fixtures annulées et absence de contrôle gérée', async () => {
  assert.equal(await db.auditLog.count({ where: { targetId: { in: [targetId, targetId - 1] } } }), 0);
  assert.deepEqual(await latestControls(db, [targetId]), []);
});
