const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('discovery');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('discovery');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : découverte concurrente unique, choix explicite et pronostics/points inchangés',
  { skip },
  async () => {
    const D = require('../../src/services/ftlEventDiscovery');
    const A = 'A'.repeat(32),
      B = 'B'.repeat(32);
    const user = await db.user.create({
      data: { name: 'discovery-test', email: 'discovery@example.invalid', password: 'test' },
    });
    const t = await db.tournament.create({
      data: { name: 'TEST DISCOVERY', ftlSourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${A}` },
    });
    const c = await db.competition.create({ data: { name: 'TEST MEN', ftlEventId: A, tournamentId: t.id } });
    t.competitions = [c];
    await db.auditLog.create({
      data: {
        actorId: user.id,
        action: 'Aperçu tournoi FTL',
        targetType: 'FtlTournamentPreview',
        targetId: user.id,
        after: { sourceUrl: t.ftlSourceUrl, events: [{ eventId: A }] },
      },
    });
    const match = await db.match.create({
      data: {
        competitionId: c.id,
        player1: 'TEST A',
        player2: 'TEST B',
        round: 'T64',
        score1: 15,
        score2: 10,
        winner: 1,
        isFinished: true,
        isLocked: true,
      },
    });
    const prediction = await db.prediction.create({
      data: { userId: user.id, matchId: match.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4 },
    });
    const now = new Date('2026-10-14T12:00:00Z');
    let mails = 0,
      pushes = 0;
    const row = (id, event) =>
      `<tr id="ev_${id}"><td>9:00 AM</td><td><a href="/events/view/${id}">${event}</a></td></tr>`;
    const client = {
      login: async () => {},
      get: async () =>
        `<div class="desktop tournName">Test Cup</div><h5>Thursday October 15, 2026</h5><table class="scheduleTable"><tbody>${row(A, 'Men Foil')}${row(B, 'Women Foil')}</tbody></table>`,
    };
    const notify = async () => {
      mails++;
      pushes++;
      return { mail: 1, push: 1 };
    };
    await Promise.all([
      D.scan(db, t, { timezone: 'Asia/Tokyo' }, client, now, notify),
      D.scan(db, t, { timezone: 'Asia/Tokyo' }, client, now, notify),
    ]);
    assert.equal(mails, 1);
    assert.equal(pushes, 1);
    assert.equal(await db.competition.count({ where: { tournamentId: t.id } }), 1);
    assert.equal((await D.list(db))[0].events.length, 1);
    await D.dismiss(db, t.id, B, user.id);
    await D.scan(db, t, { timezone: 'Asia/Tokyo' }, client, new Date(now.getTime() + 3600000), notify);
    assert.equal(mails, 1);
    assert.equal((await D.list(db))[0].events.length, 0);
    const women = await db.competition.create({ data: { name: 'TEST WOMEN', ftlEventId: B, tournamentId: t.id } });
    t.competitions.push(women);
    await D.scan(db, t, { timezone: 'Asia/Tokyo' }, client, new Date(now.getTime() + 7200000), notify);
    assert.equal(mails, 1);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: prediction.id } }), prediction);
    assert.deepEqual(await db.match.findUnique({ where: { id: match.id } }), match);
  },
);
