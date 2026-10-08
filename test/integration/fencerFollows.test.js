const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
let db, server, base, issueToken;
if (url) {
  process.env.DATABASE_URL = dedicatedUrl('follows');
  process.env.JWT_SECRET = 'local-follows-integration-secret-at-least-32';
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!url) return;
  await freshDatabase('follows');
  ({ issueToken } = require('../../src/services/session'));
  const app = require('express')();
  app.use(require('express').json());
  app.use('/fencers', require('../../src/routes/fencerFollowRoutes').createRouter(db));
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await db?.$disconnect();
});
const opts = { skip: !url && 'TEST_DATABASE_URL non défini' };
async function call(method, path, user, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${issueToken(user)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
test(
  'favoris privés, ajouts concurrents idempotents, conservation des pronostics, migration et suppression',
  opts,
  async () => {
    const a = await db.user.create({
        data: { name: 'Follows A', email: 'follows-a@test.invalid', password: 'unused' },
      }),
      b = await db.user.create({ data: { name: 'Follows B', email: 'follows-b@test.invalid', password: 'unused' } });
    const t = await db.tournament.create({ data: { name: 'Étampes test' } });
    const c = await db.competition.create({
      data: { name: 'Cadets', tournamentId: t.id, podiumRoster: [{ id: 'cadet', name: 'MARTIN Léa', country: 'FRA' }] },
    });
    const j = await db.competition.create({
      data: {
        name: 'Juniors',
        tournamentId: t.id,
        podiumRoster: [{ id: 'junior', name: 'MARTIN Lea', country: 'FRA' }],
      },
    });
    const match = await db.match.create({ data: { competitionId: c.id, player1: 'MARTIN Léa', player2: 'B' } });
    const prediction = await db.prediction.create({
      data: { userId: a.id, matchId: match.id, predictedScore1: 15, predictedScore2: 8 },
    });
    assert.equal((await call('GET', '/fencers')).status, 401);
    const results = await Promise.all(
      [1, 2].map(() => call('POST', '/fencers', a, { competitionId: c.id, entryId: 'cadet', userId: b.id })),
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results[0].body.id, results[1].body.id);
    const favoriteId = results[0].body.id;
    assert.equal((await call('GET', '/fencers', b)).body.favorites.length, 0);
    assert.equal((await call('DELETE', `/fencers/${favoriteId}`, b)).status, 404);
    const juniors = await call('GET', `/fencers?competitionId=${j.id}`, a);
    assert.equal(juniors.body.links[0].entryId, 'junior');
    assert.equal((await call('POST', '/fencers', a, { competitionId: c.id, entryId: 'invented' })).status, 409);
    assert.equal(
      (
        await call('POST', '/fencers/import', a, {
          items: [
            { id: 'cadet', name: 'MARTIN Léa', country: 'FRA' },
            { id: 'fake', name: 'Unknown' },
          ],
        })
      ).body.unresolved[0],
      1,
    );
    assert.equal(await db.followedFencer.count({ where: { userId: a.id } }), 1);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: prediction.id } }), prediction);
    assert.equal((await call('DELETE', `/fencers/${favoriteId}`, a)).status, 200);
    await call('POST', '/fencers', a, { competitionId: j.id, entryId: 'junior' });
    await db.user.delete({ where: { id: a.id } });
    assert.equal(await db.followedFencer.count({ where: { userId: a.id } }), 0);
  },
);
test(
  'homonymes identiques dans une même liste : favoris séparés et aucune étoile attribuée par nom',
  opts,
  async () => {
    const u = await db.user.create({ data: { name: 'Homo', email: 'homo@test.invalid', password: 'unused' } });
    const t = await db.tournament.create({ data: { name: 'Homonymes' } });
    const c = await db.competition.create({
      data: {
        name: 'Homonymes',
        tournamentId: t.id,
        podiumRoster: [
          { id: 'a', name: 'ALEX Martin', country: 'FRA' },
          { id: 'b', name: 'ALEX Martin', country: 'FRA' },
        ],
      },
    });
    for (const entryId of ['a', 'b'])
      assert.equal((await call('POST', '/fencers', u, { competitionId: c.id, entryId })).status, 200);
    const r = await call('GET', `/fencers?competitionId=${c.id}`, u);
    assert.equal(r.body.favorites.length, 2);
    assert.equal(r.body.links.length, 2);
    assert.deepEqual(r.body.matchNames, []);
  },
);
