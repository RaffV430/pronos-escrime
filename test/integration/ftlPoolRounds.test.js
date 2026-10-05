const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url: databaseUrl, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = databaseUrl ? false : 'TEST_DATABASE_URL non défini';
let prisma;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('ftl_pool_rounds');
  prisma = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('ftl_pool_rounds');
});
after(async () => {
  await prisma?.$disconnect();
});
const { syncPools } = require('../../src/services/ftlSync');
const { samples, url, config, page, eventId } = require('../fixtures/ftl-marathon/pages');

test(
  'FTL trois tours sur PostgreSQL : nouveaux tours, résultats partiels, points et historique idempotents',
  { skip },
  async () => {
    const user = await prisma.user.create({
      data: { email: 'ftl-rounds@exemple.test', password: 'test', name: 'Test tours' },
    });
    const tournament = await prisma.tournament.create({ data: { name: config.tournament } });
    const roster = [...new Set(samples.flatMap((s) => s.rows.map((r) => r[0])))].map((name, i) => ({
      id: String(i + 1),
      name,
    }));
    const c = await prisma.competition.create({
      data: {
        tournamentId: tournament.id,
        name: config.event,
        podiumRoster: roster,
        rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${eventId}`,
      },
    });
    let stage = 0;
    const client = {
      get: async (u) => {
        const sample = samples.find((s) => url(s) === u);
        assert(sample);
        return page(sample, stage ? samples : [samples[0]], stage === 1 && sample.round === 2);
      },
    };
    const first = await syncPools(prisma, c, config, user.id, client);
    assert.deepEqual(first.warnings, []);
    assert.equal(first.finalized, 1);
    const historical = await prisma.pool.findFirst({
      where: { competitionId: c.id, sourceUrl: url(samples[0]) },
      include: { fencers: true },
    });
    const florentine = historical.fencers.find((f) => f.name === 'KOESTERS Florentine');
    const prediction = await prisma.poolPrediction.create({
      data: { userId: user.id, fencerId: florentine.id, wins: 3, losses: 2, indicator: 6, pointsEarned: 8 },
    });
    const oldPrediction = await prisma.poolPrediction.findUnique({ where: { id: prediction.id } });
    stage = 1;
    const partial = await syncPools(prisma, c, config, user.id, client);
    assert.equal(partial.checked, 3);
    assert.equal(partial.finalized, 1);
    assert(partial.warnings.some((w) => w.includes('score réciproque manquant')));
    const pools = await prisma.pool.findMany({
      where: { competitionId: c.id },
      include: { fencers: true },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      pools.map((p) => p.name),
      ['Poule 1', 'Tour 2 · Poule 1', 'Tour 3 · Poule 1'],
    );
    assert.equal(pools[1].isFinal, false);
    assert.equal(pools[1].isLocked, false);
    // FTL n'affiche que l'heure (8:00) : tour suivant au lendemain puisqu'il ne commence pas plus tard ;
    // relu bien après coup, chaque tour glisse encore d'un jour (publication supposée la veille au soir).
    assert.equal(pools[0].startsAt.toISOString(), '2026-01-31T07:00:00.000Z');
    assert.equal(pools[1].startsAt.toISOString(), '2026-02-02T07:00:00.000Z');
    assert.equal(pools[1].lockMode, 'START_OR_FIRST_RESULT');
    assert.equal(pools[2].startsAt.toISOString(), '2026-02-04T07:00:00.000Z');
    const repeated = pools[1].fencers.find((f) => f.name === 'KOESTERS Florentine');
    assert.notEqual(repeated.id, florentine.id);
    assert.equal(repeated.wins, 2);
    assert(pools[1].fencers.every((f) => f.firstResultAt));
    const pending = await prisma.poolPrediction.create({
      data: { userId: user.id, fencerId: repeated.id, wins: 2, losses: 2, indicator: 0 },
    });
    stage = 2;
    const completed = await syncPools(prisma, c, config, user.id, client);
    assert.deepEqual(completed.warnings, []);
    assert.equal(completed.finalized, 1);
    assert.equal((await prisma.poolPrediction.findUnique({ where: { id: pending.id } })).pointsEarned, 8);
    assert.deepEqual(await prisma.poolPrediction.findUnique({ where: { id: prediction.id } }), oldPrediction);
    const baseline = await prisma.pool.findMany({
      where: { competitionId: c.id },
      include: { fencers: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    const again = await syncPools(prisma, c, config, user.id, client);
    assert.equal(again.finalized, 0);
    assert.equal(again.changed, 0);
    assert.equal(again.pointsUpdated, 0);
    const after = await prisma.pool.findMany({
      where: { competitionId: c.id },
      include: { fencers: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      after.map((p) => ({ id: p.id, ids: p.fencers.map((f) => f.id), locks: p.fencers.map((f) => f.firstResultAt) })),
      baseline.map((p) => ({
        id: p.id,
        ids: p.fencers.map((f) => f.id),
        locks: p.fencers.map((f) => f.firstResultAt),
      })),
    );
    assert.equal(await prisma.poolPrediction.count({ where: { userId: user.id } }), 2);
  },
);
