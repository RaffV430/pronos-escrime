const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('archive_continuity');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('archive_continuity');
});
after(async () => db?.$disconnect());
test(
  'automatic recovery is transactional, idempotent and preserves prediction rows and earned points',
  { skip },
  async () => {
    const { recoverAddedEvents } = require('../../src/services/tournamentArchive');
    const archivedAt = new Date('2026-10-17T17:00:00Z');
    const t = await db.tournament.create({
      data: { name: 'TEST', archivedAt, ftlSourceUrl: 'https://engarde-service.com/tournament/test/event' },
    });
    const c = await db.competition.create({
      data: {
        tournamentId: t.id,
        name: 'TEST SENIOR',
        createdAt: new Date('2026-10-16'),
        podiumResolvedAt: archivedAt,
        resultsVerifiedAt: archivedAt,
        officialPodium: { finalConfirmed: true },
      },
    });
    const u = await db.user.create({ data: { email: 'archive@example.invalid', name: 'TEST', password: 'test' } });
    const m = await db.match.create({
      data: {
        competitionId: c.id,
        player1: 'TEST A',
        player2: 'TEST B',
        round: 'T2',
        score1: 15,
        score2: 10,
        isFinished: true,
      },
    });
    await db.matchRound.create({
      data: {
        competitionId: c.id,
        round: 'T2',
        expectedMatchCount: 1,
        sourceUrl: 'https://engarde-service.com/competition/test/event/senior/tableau16.htm',
        verifiedAt: archivedAt,
      },
    });
    await db.prediction.create({
      data: { userId: u.id, matchId: m.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 8, bonusPoints: 2 },
    });
    const p = await db.pool.create({
      data: { competitionId: c.id, name: 'TEST', closesAt: archivedAt, isFinal: true },
    });
    const f = await db.poolFencer.create({ data: { poolId: p.id, name: 'TEST A', position: 1 } });
    await db.poolPrediction.create({
      data: { userId: u.id, fencerId: f.id, wins: 3, losses: 2, indicator: 5, pointsEarned: 16 },
    });
    await db.podiumPrediction.create({
      data: { userId: u.id, competitionId: c.id, gold: 'A', silver: 'B', bronze1: 'C', bronze2: 'D', pointsEarned: 60 },
    });
    const added = await db.competition.create({
      data: {
        tournamentId: t.id,
        name: 'TEST M20',
        createdAt: new Date('2026-10-17T18:00:00Z'),
        ftlEventId: 'ENGARDE:test/event/m20',
      },
    });
    await db.auditLog.create({
      data: {
        actorId: 0,
        action: 'Tournoi archivé après vérification officielle',
        targetType: 'Tournament',
        targetId: t.id,
        after: { checkedAt: archivedAt.toISOString(), sourceUrl: t.ftlSourceUrl },
      },
    });
    await db.auditLog.create({
      data: {
        actorId: 0,
        action: 'Configuration FTL validée',
        targetType: 'Competition',
        targetId: added.id,
        after: { provider: 'engarde', org: 'test', tournamentSlug: 'event', compe: 'm20' },
      },
    });
    await db.ftlSyncState.create({ data: { competitionId: c.id, status: 'COMPLETE', nextAutomaticAt: null } });
    const snapshot = async () => ({
      matches: await db.match.findMany(),
      pools: await db.pool.findMany(),
      fencers: await db.poolFencer.findMany(),
      predictions: await db.prediction.findMany(),
      poolPredictions: await db.poolPrediction.findMany(),
      podiumPredictions: await db.podiumPrediction.findMany(),
      states: await db.ftlSyncState.findMany({ where: { competitionId: c.id } }),
    });
    const before = await snapshot();
    const failing = {
      tournament: db.tournament,
      $transaction: (fn) =>
        db.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get: (target, key) =>
                key === 'ftlSyncState'
                  ? {
                      findUnique: target.ftlSyncState.findUnique.bind(target.ftlSyncState),
                      upsert: async () => {
                        throw new Error('simulated state failure');
                      },
                    }
                  : target[key],
            }),
          ),
        ),
    };
    await assert.rejects(recoverAddedEvents(failing), /simulated state failure/);
    assert.equal(+(await db.tournament.findUnique({ where: { id: t.id } })).archivedAt, +archivedAt);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await db.ftlSyncState.count({ where: { competitionId: added.id } }), 0);
    assert.deepEqual(await recoverAddedEvents(db), [t.id]);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.tournament.findUnique({ where: { id: t.id } })).archivedAt, null);
    assert.ok((await db.ftlSyncState.findUnique({ where: { competitionId: added.id } })).nextAutomaticAt);
    assert.deepEqual(await recoverAddedEvents(db), []);
    assert.deepEqual(await snapshot(), before);
  },
);
