const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const { persist, read, result } = require('../../src/services/liveHistoryStore');
const { PrismaClient } = require('@prisma/client');
const skip = !url && 'TEST_DATABASE_URL non défini';
let db;
before(async () => {
  if (url) {
    await freshDatabase('live_history');
    db = new PrismaClient({ datasources: { db: { url: dedicatedUrl('live_history') } } });
  }
});
after(async () => db?.$disconnect());
test(
  'durable history survives client restart, concurrent partial writes, side reversal and archive without changing predictions',
  { skip },
  async () => {
    const t = await db.tournament.create({
      data: {
        name: 'SYNTH CUP',
        ftlSourceUrl: 'https://www.fencingtimelive.com/tournaments/eventSchedule/' + 'A'.repeat(32),
      },
    });
    const c = await db.competition.create({ data: { name: 'SYNTH', tournamentId: t.id } });
    const m = await db.match.create({
      data: {
        competitionId: c.id,
        player1: 'SYNTH A',
        player2: 'SYNTH B',
        sourceKey: 'synth',
        sourceUrl: 'https://example.invalid/bout',
        score1: 15,
        score2: 10,
        isFinished: true,
      },
    });
    const u = await db.user.create({ data: { name: 'SYNTH', email: 'history@example.invalid', password: 'test' } });
    const p = await db.prediction.create({
      data: { matchId: m.id, userId: u.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4, bonusPoints: 1 },
    });
    const hit = (n) => ({ at: new Date(1700000000000 + n).toISOString(), score1: n, score2: 0, by: 1, period: 1 });
    await Promise.all([persist(db, m, [hit(1)]), persist(db, m, [hit(2)])]);
    await persist(db, m, [hit(1)]);
    const fresh = new PrismaClient({ datasources: { db: { url: dedicatedUrl('live_history') } } });
    try {
      assert.equal((await read(fresh, m)).length, 2);
      assert.equal((await result(fresh, m.id)).history.length, 2);
    } finally {
      await fresh.$disconnect();
    }
    assert.equal((await read(db, { ...m, player1: m.player2, player2: m.player1 }))[0].by, 2);
    assert.deepEqual(await read(db, { ...m, sourceKey: 'other' }), []);
    assert.deepEqual(await read(db, { ...m, player1: 'OTHER' }), []);
    await persist(db, { ...m, player1: 'OTHER' }, [hit(3)]);
    assert.equal((await read(db, m)).length, 2);
    await db.tournament.update({ where: { id: t.id }, data: { archivedAt: new Date() } });
    assert.equal((await result(db, m.id)).history.length, 2);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
    assert.deepEqual(await db.match.findUnique({ where: { id: m.id } }), m);
    await db.match.update({ where: { id: m.id }, data: { score1: 1 } });
    assert.equal((await result(db, m.id)).history.length, 0);
    assert.ok((await result(db, m.id)).historyIssue);
  },
);

test(
  'existing worker saves without viewers, restores unfinished history and avoids clock-only writes',
  { skip },
  async () => {
    const guid = 'B'.repeat(32);
    const t = await db.tournament.create({
      data: { name: 'SYNTH WORKER', ftlSourceUrl: 'https://www.fencingtimelive.com/tournaments/eventSchedule/' + guid },
    });
    const c = await db.competition.create({ data: { name: 'SYNTH WORKER', tournamentId: t.id } });
    const m = await db.match.create({
      data: { competitionId: c.id, player1: 'SYNTH C', player2: 'SYNTH D', sourceKey: 'worker' },
    });
    const e = { at: '2026-10-25T10:00:00.000Z', by: 'start', score1: 3, score2: 2, period: 1 };
    await persist(db, m, [e]);
    const live = require('../../src/services/ftlLiveScores');
    const msg = (score, clock) => ({
      TournGuid: guid,
      StripNum: 'TEST',
      Clock: clock,
      PeriodNum: 1,
      Left: { Name: m.player1, Score: score },
      Right: { Name: m.player2, Score: 2 },
    });
    const now = Date.parse(e.at) + 1000;
    live.record(msg(5, 100), now, new Set([guid]));
    await live.persistLiveLocks(db, c.id, now);
    let saved = await db.matchLiveHistory.findUnique({ where: { matchId: m.id } });
    assert.equal(saved.history[0].score1, 3);
    assert.equal(saved.history.at(-1).by, 'gap');
    assert.equal(saved.history.at(-1).score1, 5);
    const updated = saved.updatedAt;
    live.record(msg(5, 99), now + 1000, new Set([guid]));
    await live.persistLiveLocks(db, c.id, now + 1000);
    saved = await db.matchLiveHistory.findUnique({ where: { matchId: m.id } });
    assert.deepEqual(saved.updatedAt, updated);
    assert.ok((await db.match.findUnique({ where: { id: m.id } })).liveDetectedAt);
    assert.equal((await db.match.findUnique({ where: { id: m.id } })).score1, null);
  },
);
