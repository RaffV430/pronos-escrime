const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, freshDatabase } = require('./helpers');
const { PrismaClient } = require('@prisma/client');
const { record, confirm } = require('../../src/services/identityReview');
let db;
before(async () => {
  if (url) db = new PrismaClient({ datasourceUrl: await freshDatabase('identity_review') });
});
after(async () => {
  await db?.$disconnect();
});
test(
  'PostgreSQL: concurrent confirmations serialize and preserve existing podium predictions',
  { skip: !url && 'TEST_DATABASE_URL non défini' },
  async () => {
    const tournament = await db.tournament.create({ data: { name: 'Test identités' } });
    const c = await db.competition.create({
      data: {
        tournamentId: tournament.id,
        name: 'Fleuret',
        podiumRoster: [{ id: 'kept', name: 'MARTIN Alex', country: 'FRA' }],
      },
    });
    const user = await db.user.create({ data: { name: 'Test', email: 'identity@example.test', password: 'unused' } });
    const prediction = await db.podiumPrediction.create({
      data: {
        userId: user.id,
        competitionId: c.id,
        gold: 'MARTIN Alex',
        silver: 'B',
        bronze1: 'C',
        bronze2: 'D',
        selectionIds: { gold: 'kept' },
        pointsEarned: 5,
      },
    });
    await record(db, c, 'https://engarde-service.com/competition/a/b/c/tireurs.htm', [
      { id: 'new', name: 'MARTIN Alex', country: 'ITA' },
    ]);
    const pending = await db.competition.findUnique({ where: { id: c.id } });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        confirm(db, c.id, pending.identityReview.version, 'Nation vérifiée sur la source officielle', user.id),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    assert.deepEqual(await db.podiumPrediction.findUnique({ where: { id: prediction.id } }), prediction);
    const updated = await db.competition.findUnique({ where: { id: c.id } });
    assert.equal(updated.podiumRoster[0].id, 'kept');
    assert.equal(updated.identityReview, null);
    assert.equal(await db.auditLog.count({ where: { targetId: c.id, action: 'Identités officielles confirmées' } }), 1);
  },
);
