const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const S = require('../../src/services/calendarSource');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('calendar_source');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('calendar_source');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL : deux plateformes simultanées créent un seul tournoi et préservent les pronostics',
  { skip },
  async () => {
    const t = await db.tournament.create({ data: { name: 'SYNTH PRESERVE' } });
    const c = await db.competition.create({ data: { tournamentId: t.id, name: 'SYNTH' } });
    const u = await db.user.create({ data: { name: 'SYNTH', email: 'calendar@example.test', password: 'test' } });
    const m = await db.match.create({ data: { competitionId: c.id, player1: 'A', player2: 'B' } });
    const p = await db.prediction.create({
      data: { userId: u.id, matchId: m.id, predictedScore1: 15, predictedScore2: 8, pointsEarned: 4, bonusPoints: 1 },
    });
    const id = require('../../src/data/calendar.json').events.find((e) => e.city === 'Ankara').id;
    const save = (source) =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184722)`;
        const previous = await S.check(tx, id, source);
        const tournament = previous
          ? await tx.tournament.findUnique({ where: { id: previous.tournamentId } })
          : await tx.tournament.create({ data: { name: 'SYNTH WORLD', ftlSourceUrl: source } });
        await S.bind(tx, id, source, tournament.id, u.id, previous);
        return tournament;
      });
    const results = await Promise.allSettled([save('https://ftl.example.test'), save('https://engarde.example.test')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    assert.equal(await db.tournament.count({ where: { name: 'SYNTH WORLD' } }), 1);
    const winner = results.find((r) => r.status === 'fulfilled').value;
    assert.equal((await save(winner.ftlSourceUrl)).id, winner.id);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
  },
);
test(
  'Hénin : rattacher le tournoi existant une seule fois, garder les deux journées et ses compétitions',
  { skip },
  async () => {
    const source = 'https://engarde-service.com/tournament/heninbeaumont/seniorf1026';
    const calendarId = '2026-10-17-henin-beaumont-senior-ind';
    const u = await db.user.create({ data: { name: 'TEST', email: 'henin-link@example.invalid', password: 'test' } });
    const t = await db.tournament.create({ data: { name: 'TEST HENIN', ftlSourceUrl: source } });
    const c = await db.competition.create({ data: { name: 'Fleuret Hommes senior', tournamentId: t.id } });
    await db.auditLog.create({
      data: {
        actorId: u.id,
        action: 'Configuration FTL validée',
        targetType: 'Competition',
        targetId: c.id,
        after: { date: '2026-10-17' },
      },
    });
    await Promise.all([
      S.linkExisting(db, calendarId, source, t.id, u.id),
      S.linkExisting(db, calendarId, source, t.id, u.id),
    ]);
    assert.equal(await db.auditLog.count({ where: { action: 'Calendrier : tournoi relié', targetId: t.id } }), 1);
    const listed = await require('../../src/services/calendarWatch').upcoming(db, Date.parse('2026-10-16T12:00Z'));
    const entry = listed.find((e) => e.id === calendarId);
    assert.deepEqual(
      [entry.tournamentId, entry.start, entry.end, entry.competitionIds],
      [t.id, '2026-10-17', '2026-10-18', [c.id]],
    );
    await assert.rejects(S.linkExisting(db, calendarId, 'https://other.invalid', t.id, u.id), /Source/);
  },
);
