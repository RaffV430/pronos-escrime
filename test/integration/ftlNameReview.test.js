const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('ftl_names');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('ftl_names');
});
after(async () => db?.$disconnect());
test('PostgreSQL : correction journalisée sans modifier roster, IDs, pronostics ni points', { skip }, async () => {
  const R = require('../../src/services/ftlNameReview');
  const u = await db.user.create({ data: { name: 'TEST', email: 'name-review@example.invalid', password: 'test' } });
  const t = await db.tournament.create({ data: { name: 'TEST' } });
  const c = await db.competition.create({
    data: { tournamentId: t.id, name: 'TEST', podiumRoster: [{ id: 'a', name: 'ALPHA Roy J.', country: 'USA' }] },
  });
  await db.auditLog.create({
    data: {
      actorId: u.id,
      action: 'Contrôle FTL terminé',
      targetType: 'Competition',
      targetId: c.id,
      after: { warnings: ['T256 · match 120 : Nom officiel ambigu ou absent des engagés : ALPHA Roy.'] },
    },
  });
  const m = await db.match.create({
    data: {
      competitionId: c.id,
      round: 'J1:T256',
      player1: 'A',
      player2: 'B',
      score1: 15,
      score2: 10,
      winner: 1,
      isFinished: true,
    },
  });
  const p = await db.prediction.create({
    data: { userId: u.id, matchId: m.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4 },
  });
  const r = await R.review(db, c.id);
  await R.confirm(
    db,
    c.id,
    {
      sourceName: 'ALPHA Roy',
      entryId: 'a',
      reason: 'Identité vérifiée sur la source officielle',
      confirm: true,
      version: r.version,
    },
    u.id,
  );
  assert.equal((await R.aliases(db, c.id)).length, 1);
  assert.deepEqual(await db.competition.findUnique({ where: { id: c.id } }), c);
  assert.deepEqual(await db.match.findUnique({ where: { id: m.id } }), m);
  assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
  const other = await db.competition.create({ data: { tournamentId: t.id, name: 'OTHER' } });
  assert.deepEqual(await R.aliases(db, other.id), []);
  await assert.rejects(
    R.confirm(
      db,
      c.id,
      {
        sourceName: 'ALPHA Roy',
        entryId: 'a',
        reason: 'Identité vérifiée sur la source officielle',
        confirm: true,
        version: r.version,
      },
      u.id,
    ),
    /changé/,
  );
  const current = await R.review(db, c.id);
  await R.remove(db, c.id, { sourceName: 'ALPHA Roy', version: current.version }, u.id);
  assert.deepEqual(await R.aliases(db, c.id), []);
  assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
});
