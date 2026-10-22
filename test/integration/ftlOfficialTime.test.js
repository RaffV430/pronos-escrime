const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('official_time');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('official_time');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : nouvel horaire concordant, poule fermée et tous les pronostics/points conservés',
  { skip },
  async () => {
    const root = 'https://www.fencingtimelive.com',
      eventId = 'A'.repeat(32),
      calendarId = 'B'.repeat(32);
    const user = await db.user.create({
      data: { name: 'TEST', email: 'official-time@example.invalid', password: 'test' },
    });
    const tournament = await db.tournament.create({ data: { name: 'TEST Cup' } });
    const c = await db.competition.create({
      data: {
        name: 'TEST Women',
        tournamentId: tournament.id,
        ftlEventId: eventId,
        rosterSourceUrl: `${root}/events/competitors/${eventId}`,
      },
    });
    const oldStart = new Date('2026-10-22T12:00Z'),
      now = new Date('2026-10-22T12:10Z'),
      newStart = new Date('2026-10-22T12:30Z');
    const pool = await db.pool.create({
      data: {
        competitionId: c.id,
        name: 'Poule 1',
        lockMode: 'START_OR_FIRST_RESULT',
        closesAt: oldStart,
        startsAt: oldStart,
        sourceUrl: `${root}/pools/scores/${eventId}/${calendarId}`,
        sourcePoolNumber: 1,
        fencers: {
          create: [
            { name: 'TEST A', position: 1 },
            { name: 'TEST B', position: 2 },
          ],
        },
      },
      include: { fencers: { orderBy: { position: 'asc' } } },
    });
    const prediction = await db.poolPrediction.create({
      data: {
        userId: user.id,
        fencerId: pool.fencers[0].id,
        wins: 1,
        losses: 0,
        indicator: null,
        pointsEarned: 8,
        savedAt: new Date('2026-10-22T11:50Z'),
      },
    });
    const match = await db.match.create({
      data: { competitionId: c.id, player1: 'TEST A', player2: 'TEST B', round: 'T2' },
    });
    const matchPrediction = await db.prediction.create({
      data: {
        userId: user.id,
        matchId: match.id,
        predictedScore1: 15,
        predictedScore2: 10,
        pointsEarned: 4,
        bonusPoints: 1,
      },
    });
    const podiumPrediction = await db.podiumPrediction.create({
      data: {
        userId: user.id,
        competitionId: c.id,
        gold: 'TEST A',
        silver: 'TEST B',
        bronze1: 'TEST C',
        bronze2: 'TEST D',
        pointsEarned: 9,
      },
    });
    const config = {
      eventId,
      name: c.name,
      event: c.name,
      tournament: tournament.name,
      format: 'INDIVIDUAL',
      date: '2026-10-22',
      time: '1:00 PM',
      eventTime: '2026-10-22 1:00 PM',
      timezone: 'Africa/Tunis',
      scheduleUrl: `${root}/tournaments/eventSchedule/${calendarId}`,
      poolSources: [pool.sourceUrl],
    };
    await db.auditLog.create({
      data: {
        actorId: user.id,
        action: 'Configuration FTL validée',
        targetType: 'Competition',
        targetId: c.id,
        after: config,
      },
    });
    let published = '1:30 PM';
    const client = {
      eventPage: async () => ({
        url: c.rosterSourceUrl,
        html: `<span class="desktop tournName">${tournament.name}</span><span class="desktop eventName">${c.name}</span><span class="desktop eventTime">2026-10-22 ${published}</span><a href="${c.rosterSourceUrl}">Fencers</a><a href="${config.scheduleUrl}">Schedule</a>`,
      }),
      get: async () =>
        `<span class="desktop tournName">${tournament.name}</span><h5>2026-10-22</h5><table class="scheduleTable"><tbody><tr id="ev_${eventId}"><td>1:30 PM</td><td><a href="/events/view/${eventId}">${c.name}</a></td></tr></tbody></table>`,
    };
    const { refresh } = require('../../src/services/ftlOfficialTime');
    const next = await refresh(db, c, config, user.id, client, now.getTime());
    assert.equal(next.time, '1:30 PM');
    assert.deepEqual(await db.poolPrediction.findUnique({ where: { id: prediction.id } }), prediction);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: matchPrediction.id } }), matchPrediction);
    assert.deepEqual(await db.podiumPrediction.findUnique({ where: { id: podiumPrediction.id } }), podiumPrediction);
    assert.deepEqual(await db.match.findUnique({ where: { id: match.id } }), match);
    await db.$transaction((tx) =>
      require('../../src/services/ftlPools').applyPool(
        tx,
        pool,
        {
          complete: false,
          ambiguous: false,
          startsAt: newStart,
          closeAtStart: true,
          rows: pool.fencers.map((f) => ({ name: f.name, position: f.position, firstResult: false, hasResult: false })),
        },
        now,
      ),
    );
    const afterPool = await db.pool.findUnique({ where: { id: pool.id } });
    assert.equal(afterPool.closesAt.getTime(), oldStart.getTime());
    assert.equal(afterPool.startsAt.getTime(), newStart.getTime());
    assert.equal(require('../../src/services/poolRules').closed(afterPool, now), true);
    assert.deepEqual(await db.poolPrediction.findUnique({ where: { id: prediction.id } }), prediction);
    const count = await db.auditLog.count();
    assert.deepEqual(await refresh(db, c, next, user.id, client), next);
    assert.equal(await db.auditLog.count(), count);
    published = '2:00 PM';
    await assert.rejects(refresh(db, c, next, user.id, client));
    assert.equal(await db.auditLog.count(), count);
    assert.deepEqual(await db.competition.findUnique({ where: { id: c.id } }), c);
  },
);
