const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('phases');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('phases');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : passage J1 → J2 préserve IDs, pronostic, points, date du résultat et réimport idempotent',
  { skip },
  async () => {
    const user = await db.user.create({
      data: { name: 'phase-test', email: 'phase@example.invalid', password: 'test' },
    });
    const tournament = await db.tournament.create({ data: { name: 'TEST PHASES' } });
    const c = await db.competition.create({
      data: { name: 'TEST EVENT', tournamentId: tournament.id, podiumFormat: 'INDIVIDUAL', podiumRoster: [] },
    });
    const when = new Date('2026-01-09T11:00:00Z');
    const old = await db.match.create({
      data: {
        competitionId: c.id,
        player1: 'TEST A',
        player2: 'TEST B',
        round: 'T64',
        sourceUrl: 'j1',
        sourceKey: 'Table of 64:1',
        score1: 15,
        score2: 10,
        winner: 1,
        isFinished: true,
        isLocked: true,
        resultRegisteredAt: when,
      },
    });
    const prediction = await db.prediction.create({
      data: { userId: user.id, matchId: old.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4 },
    });
    await db.matchRound.create({
      data: {
        competitionId: c.id,
        round: 'T64',
        previousRound: null,
        expectedMatchCount: 1,
        sourceUrl: 'j1',
        verifiedAt: when,
      },
    });
    const { preliminary, combine } = require('../../src/services/ftlTableauPhases');
    const { applyObservation } = require('../../src/services/ftlSync');
    const p = preliminary({
      sourceUrl: 'j1',
      checkedAt: when,
      matches: [{ ...old }],
      rounds: [{ round: 'T64', previousRound: null, expectedMatchCount: 1 }],
      byes: [],
      issues: [],
      warnings: [],
    });
    const main = {
      sourceUrl: 'j2',
      checkedAt: when,
      matches: [
        {
          sourceKey: 'Table of 64:1',
          round: 'T64',
          player1: 'TEST A',
          player2: 'TEST C',
          isFinished: false,
          startsAt: new Date('2026-01-10T08:00:00Z'),
        },
      ],
      rounds: [
        { round: 'T64', previousRound: null, expectedMatchCount: 1 },
        { round: 'T2', previousRound: null, expectedMatchCount: 1 },
      ],
      byes: [],
      issues: [],
      warnings: [],
    };
    // Le résultat final n'est pas simulé : T2 vide n'attribue aucun podium.
    const observed = combine([p, main]);
    await db.$transaction((tx) => applyObservation(tx, c, observed, user.id));
    const first = await db.match.findMany({ where: { competitionId: c.id }, orderBy: { id: 'asc' } });
    assert.equal(first.length, 2);
    assert.equal(first[0].id, old.id);
    assert.equal(first[0].round, 'J1:T64');
    assert.equal(first[0].resultRegisteredAt.toISOString(), old.resultRegisteredAt.toISOString());
    assert.deepEqual(await db.prediction.findUnique({ where: { id: prediction.id } }), prediction);
    await db.$transaction((tx) => applyObservation(tx, c, observed, user.id));
    const again = await db.match.findMany({ where: { competitionId: c.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(
      again.map((m) => m.id),
      first.map((m) => m.id),
    );
    assert.deepEqual(await db.prediction.findUnique({ where: { id: prediction.id } }), prediction);
  },
);
