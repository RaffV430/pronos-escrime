const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('live_lock');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('live_lock');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : le live verrouille uniquement sa rencontre, persiste et conserve les pronostics et points',
  { skip },
  async () => {
    const F = require('../../src/services/ftlLiveScores');
    const { matchClosed } = require('../../src/lib/matchLock');
    const guid = 'A1234567890123456789012345678901';
    const t = await db.tournament.create({
      data: { name: 'LIVE TEST', ftlSourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${guid}` },
    });
    const c = await db.competition.create({ data: { tournamentId: t.id, name: 'LIVE TEST' } });
    const u = await db.user.create({ data: { email: 'live-lock@example.test', password: 'test', name: 'TEST' } });
    const a = await db.match.create({
      data: {
        competitionId: c.id,
        round: 'J1:T64',
        player1: 'SYNTH LIVE A',
        player2: 'SYNTH LIVE B',
        startsAt: new Date(Date.now() + 86400000),
      },
    });
    const b = await db.match.create({
      data: {
        competitionId: c.id,
        round: 'J1:T64',
        player1: 'SYNTH LIVE C',
        player2: 'SYNTH LIVE D',
        startsAt: a.startsAt,
      },
    });
    const p = await db.prediction.create({
      data: { userId: u.id, matchId: a.id, predictedScore1: 15, predictedScore2: 8, pointsEarned: 4, bonusPoints: 1 },
    });
    const now = Date.now();
    F.record(
      {
        TournGuid: guid,
        StripNum: '1',
        Clock: 180,
        PeriodNum: 1,
        Left: { Name: a.player1, Score: 0 },
        Right: { Name: a.player2, Score: 0 },
      },
      now,
      new Set([guid]),
    );
    await F.persistLiveLocks(db, c.id, now);
    const preloaded = await db.match.findUnique({ where: { id: a.id } });
    assert.equal(preloaded.liveDetectedAt, null);
    assert.equal(matchClosed(preloaded, now), false);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
    F.record(
      {
        TournGuid: guid,
        StripNum: '1',
        Clock: 179,
        PeriodNum: 1,
        Left: { Name: a.player1, Score: 0 },
        Right: { Name: a.player2, Score: 0 },
      },
      now + 1,
      new Set([guid]),
    );
    await F.persistLiveLocks(db, c.id, now + 1);
    const locked = await db.match.findUnique({ where: { id: a.id } });
    assert.equal(locked.liveDetectedAt.toISOString(), new Date(now + 1).toISOString());
    assert.equal(matchClosed(locked, now), true);
    assert.equal((await db.match.findUnique({ where: { id: b.id } })).liveDetectedAt, null);
    assert.equal(matchClosed(await db.match.findUnique({ where: { id: b.id } }), now), false);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
    F._strips.clear();
    await F.persistLiveLocks(db, c.id, now + 10000);
    assert.equal(
      (await db.match.findUnique({ where: { id: a.id } })).liveDetectedAt.toISOString(),
      locked.liveDetectedAt.toISOString(),
    );
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
  },
);
