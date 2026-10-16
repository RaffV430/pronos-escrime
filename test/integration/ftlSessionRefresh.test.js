const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('session_refresh');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('session_refresh');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : sessions anciennes enrichies, sources et pronostic existant conservés, réexécution idempotente',
  { skip },
  async () => {
    const user = await db.user.create({
      data: { name: 'TEST', email: 'session-refresh@example.invalid', password: 'test' },
    });
    const t = await db.tournament.create({ data: { name: 'TEST World Cup' } });
    const c = await db.competition.create({ data: { name: 'TEST Women', tournamentId: t.id } });
    const match = await db.match.create({
      data: { competitionId: c.id, player1: 'TEST A', player2: 'TEST B', round: 'J1:T64' },
    });
    const p = await db.prediction.create({
      data: {
        userId: user.id,
        matchId: match.id,
        predictedScore1: 15,
        predictedScore2: 10,
        pointsEarned: 4,
        bonusPoints: 1,
      },
    });
    const id = 'A'.repeat(32);
    const config = {
      eventId: id,
      event: 'TEST Women',
      name: c.name,
      date: '2026-10-16',
      time: '9:00 AM',
      format: 'INDIVIDUAL',
      timezone: 'Asia/Tokyo',
      tournament: t.name,
      scheduleUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${id}`,
      sourceUrl: 'existing-tableau',
      poolSources: ['existing-pools'],
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
    const session = (day, date) =>
      `<h5>${date}</h5><table class="scheduleTable"><tbody><tr id="ev_${id}"><td>9:00 AM</td><td><a href="/events/view/${id}">TEST Women (Day ${day})</a></td></tr></tbody></table>`;
    const client = {
      get: async () =>
        `<div class="desktop tournName">TEST World Cup</div>${session(1, 'Friday October 16, 2026')}${session(2, 'Sunday October 18, 2026')}`,
    };
    const { refreshSessions } = require('../../src/services/ftlTournament');
    const next = await refreshSessions(db, c, config, user.id, client);
    assert.equal(next.scheduleSessions.length, 2);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
    assert.deepEqual(await db.match.findUnique({ where: { id: match.id } }), match);
    assert.equal(next.sourceUrl, config.sourceUrl);
    assert.deepEqual(next.poolSources, config.poolSources);
    await refreshSessions(db, c, next, user.id, { get: () => assert.fail('pas de nouvelle lecture') });
    assert.equal(
      await db.auditLog.count({
        where: { targetType: 'Competition', targetId: c.id, action: 'Configuration FTL validée' },
      }),
      2,
    );
  },
);
