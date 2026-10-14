const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('podium_opening');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('podium_opening');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : podium attend le principal, puis ouvre sans attendre J2 ; ancien pronostic et points intacts',
  { skip },
  async () => {
    const { forCompetition } = require('../../src/services/podiumAvailability');
    const user = await db.user.create({
      data: { name: 'podium-test', email: 'podium@example.invalid', password: 'test' },
    });
    const t = await db.tournament.create({ data: { name: 'TEST PODIUM PHASES' } });
    const c = await db.competition.create({
      data: {
        tournamentId: t.id,
        name: 'TEST EVENT',
        podiumRoster: ['A', 'B', 'C', 'D'].map((name) => ({ id: name, name, country: 'FRA' })),
      },
    });
    await db.auditLog.create({
      data: {
        actorId: user.id,
        action: 'Configuration FTL validée',
        targetType: 'Competition',
        targetId: c.id,
        after: { timezone: 'Asia/Tokyo', scheduleSessions: [{ date: '2099-01-01' }, { date: '2099-01-02' }] },
      },
    });
    const pick = await db.podiumPrediction.create({
      data: {
        userId: user.id,
        competitionId: c.id,
        gold: 'A',
        silver: 'B',
        bronze1: 'C',
        bronze2: 'D',
        pointsEarned: 20,
      },
    });
    const old = await db.match.create({
      data: {
        competitionId: c.id,
        round: 'J1:T4',
        player1: 'A',
        player2: 'B',
        score1: 15,
        score2: 10,
        winner: 1,
        isFinished: true,
      },
    });
    assert.equal((await forCompetition(db, c)).notYetOpen, true);
    await db.match.create({ data: { competitionId: c.id, round: 'T4', player1: 'A', player2: 'B' } });
    assert.equal((await forCompetition(db, c)).notYetOpen, true);
    await db.match.create({ data: { competitionId: c.id, round: 'T4', player1: 'C', player2: 'D' } });
    assert.equal((await forCompetition(db, c)).notYetOpen, false);
    assert.deepEqual(await db.podiumPrediction.findUnique({ where: { id: pick.id } }), pick);
    assert.deepEqual(await db.match.findUnique({ where: { id: old.id } }), old);
  },
);
