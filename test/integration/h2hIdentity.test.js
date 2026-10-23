const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const { headToHead } = require('../../src/services/headToHead');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('h2h_identity');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('h2h_identity');
});
after(async () => db?.$disconnect());
test('PostgreSQL: linked club/country histories, pagination and predictions remain intact', { skip }, async () => {
  const name = 'EXEMPLE Alex',
    opponent = 'AUTRE Camille';
  const tournament = await db.tournament.create({ data: { name: 'Tournoi fictif' } });
  const affiliation = await db.fencerAffiliation.create({
    data: {
      identityKey: 'h2h-test',
      name,
      nameKey: 'EXEMPLE ALEX',
      country: 'FRA',
      federationVerified: true,
    },
  });
  const comp = async (country, linked) =>
    db.competition.create({
      data: {
        tournamentId: tournament.id,
        name: 'Épreuve fictive',
        podiumRoster: [
          { id: 'a', name, country },
          { id: 'b', name: opponent, country: 'ITA' },
        ],
        ...(linked ? { affiliationEntries: { create: { entryId: 'a', affiliationId: affiliation.id } } } : {}),
      },
    });
  const international = await comp('FRA', true),
    national = await comp('CLUB FICTIF', true),
    homonym = await comp('ITA', false);
  const current = await db.match.create({
    data: { competitionId: international.id, player1: name, player2: opponent, round: 'T2' },
  });
  const expected = [];
  for (let i = 0; i < 32; i++) {
    const row = await db.match.create({
      data: {
        competitionId: i < 27 ? homonym.id : national.id,
        player1: name,
        player2: opponent,
        round: 'T32',
        isFinished: true,
        pointsPending: false,
        winner: i % 2 ? 1 : 2,
        score1: i % 2 ? 15 : 9,
        score2: i % 2 ? 9 : 15,
        startsAt: new Date(Date.UTC(2026, 9, 23, 12, 0, -i)),
      },
    });
    if (i >= 27) expected.push(row.id);
  }
  const user = await db.user.create({ data: { name: 'TEST', email: 'h2h@example.invalid', password: 'test' } });
  await db.prediction.create({
    data: { userId: user.id, matchId: expected[0], predictedScore1: 15, predictedScore2: 9, pointsEarned: 4 },
  });
  await db.podiumPrediction.create({
    data: {
      userId: user.id,
      competitionId: international.id,
      gold: name,
      silver: opponent,
      bronze1: 'TEST C',
      bronze2: 'TEST D',
      pointsEarned: 7,
    },
  });
  const pool = await db.pool.create({
    data: {
      competitionId: national.id,
      name: 'Poule fictive',
      closesAt: new Date('2026-10-23T10:00Z'),
      fencers: { create: [{ name, position: 1 }] },
    },
    include: { fencers: true },
  });
  await db.poolPrediction.create({
    data: { userId: user.id, fencerId: pool.fencers[0].id, wins: 0, losses: 0, pointsEarned: 3 },
  });
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all([
        db.prediction.findMany(),
        db.poolPrediction.findMany(),
        db.podiumPrediction.findMany(),
        db.match.findMany({ orderBy: { id: 'asc' } }),
        db.fencerAffiliation.findMany(),
        db.fencerAffiliationEntry.findMany(),
      ]),
    );
  const beforeRead = await snapshot();
  const result = await headToHead(db, current.id);
  assert.deepEqual(
    result.form.player1.map((r) => r.matchId),
    expected,
  );
  assert.deepEqual(
    result.meetings.map((r) => r.matchId),
    expected,
  );
  assert.equal(await snapshot(), beforeRead);
});
