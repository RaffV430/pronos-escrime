// Pires scénarios FencingTimeLive sur un vrai PostgreSQL : site indisponible pendant les poules,
// matrice d'une poule manquante. Aucune donnée perdue, reprise automatique.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url: databaseUrl, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = databaseUrl ? false : 'TEST_DATABASE_URL non défini';
let prisma;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('worst_ftl');
  prisma = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('worst_ftl');
});
after(async () => {
  await prisma?.$disconnect();
});
const { syncPools } = require('../../src/services/ftlSync');
const { failure } = require('../../src/services/ftlClient');
const { samples, url, config, page, eventId } = require('../fixtures/ftl-marathon/pages');

async function event(name) {
  const user = await prisma.user.create({
    data: { email: `${name}@exemple.test`, password: 'x', name: `Test ${name}` },
  });
  const tournament = await prisma.tournament.create({ data: { name: `${config.tournament} ${name}` } });
  const roster = [...new Set(samples.flatMap((s) => s.rows.map((r) => r[0])))].map((n, i) => ({
    id: String(i + 1),
    name: n,
  }));
  const c = await prisma.competition.create({
    data: {
      tournamentId: tournament.id,
      name: config.event,
      podiumRoster: roster,
      rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${eventId}`,
    },
  });
  return { user, c };
}

test('FTL indisponible pendant les poules : avertissement, rien de perdu, reprise ensuite', { skip }, async () => {
  const { user, c } = await event('ftl-down');
  const cfg = { ...config, poolSources: [url(samples[0])] };
  const ok = { get: async () => page(samples[0], [samples[0]], true) };
  await syncPools(prisma, c, cfg, user.id, ok);
  const pools = await prisma.pool.count({ where: { competitionId: c.id } });
  assert.equal(pools, 1);
  const down = {
    get: async () => {
      throw failure('La source officielle est temporairement indisponible.');
    },
  };
  const s = await syncPools(prisma, c, cfg, user.id, down);
  assert.ok(s.warnings.length, 'panne signalée');
  assert.equal(await prisma.pool.count({ where: { competitionId: c.id } }), pools);
  const back = await syncPools(prisma, c, cfg, user.id, { get: async () => page(samples[0], [samples[0]]) });
  assert.equal(back.finalized, 1);
});

test(
  'FTL : page de poules sans tableau de matrices (publication en cours) : aucune poule inventée',
  { skip },
  async () => {
    const { user, c } = await event('ftl-empty');
    const cfg = { ...config, poolSources: [url(samples[0])] };
    const empty = page(samples[0], [samples[0]]).replace(/<table class="poolTable">[\s\S]*<\/table>/, '');
    const s = await syncPools(prisma, c, cfg, user.id, { get: async () => empty });
    assert.ok(s.warnings.length);
    assert.equal(await prisma.pool.count({ where: { competitionId: c.id } }), 0);
  },
);
