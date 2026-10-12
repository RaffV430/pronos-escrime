const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, freshDatabase } = require('./helpers');
const A = require('../../src/services/fencerAffiliations');
const F = require('../../src/services/fencerFollows');
const D = require('../../src/services/fencerDirectory');
const I = require('../../src/services/fencerCatalogImport');
let db;
before(async () => {
  if (url) {
    const { PrismaClient } = require('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: await freshDatabase('fencer_catalog') } } });
  }
});
after(async () => {
  if (db) await db.$disconnect();
});
test(
  'fiche sans compétition : import idempotent, favori conservé et futur engagement lié sans toucher aux pronostics',
  { skip: !url },
  async () => {
    const user = await db.user.create({
      data: { name: 'Test catalogue', email: 'catalog@example.test', password: 'test' },
    });
    const row = {
      federationKey: 'a'.repeat(64),
      name: 'CATALOGUE Lea',
      country: 'FRA',
      birthYear: 1965,
      club: 'Club A',
      clubCode: '12345678',
      sourceUrl: 'FFE_RANKING:' + 'b'.repeat(64) + ':2',
      observedAt: '2026-10-09T00:00:00.000Z',
    };
    await I.importRows(db, [row]);
    let p = await db.fencerAffiliation.findUnique({ where: { federationKey: row.federationKey } });
    const favorite = await F.followProfile(db, user.id, p.id);
    assert.equal(favorite.originCompetitionId, null);
    assert.equal((await F.followProfile(db, user.id, p.id)).id, favorite.id);
    let directory = await D.search(db, user.id, { query: 'CATALOGUE', offset: 0 });
    assert.equal(directory.results[0].events.length, 0);
    assert.equal(directory.results[0].favoriteId, favorite.id);
    assert.equal(directory.results[0].ageCategory, 'V3');
    await I.importRows(db, [row]);
    assert.equal(await db.fencerAffiliation.count(), 1);
    const tournament = await db.tournament.create({ data: { name: 'Test futur' } });
    const c = await db.competition.create({
      data: {
        tournamentId: tournament.id,
        name: 'Test',
        podiumRoster: [{ id: 'a', name: row.name, country: 'FRA', club: 'Club B' }],
      },
    });
    await db.$transaction((tx) =>
      A.ingest(tx, c, c.podiumRoster, 'https://www.fencingtimelive.com/events/test', new Date()),
    );
    assert.equal((await F.list(db, user.id, c.id)).links[0].favoriteId, favorite.id);
    assert.equal((await F.follow(db, user.id, c.id, 'a')).id, favorite.id);
    await I.importRows(db, [row]);
    p = await db.fencerAffiliation.findUnique({ where: { id: p.id } });
    assert.equal(p.club, 'Club B');
    const other = await db.fencerAffiliation.create({
      data: {
        identityKey: 'homonyme',
        name: row.name,
        nameKey: A.key(row.name),
        country: 'FRA',
        federationVerified: true,
      },
    });
    const ambiguous = await db.competition.create({
      data: {
        tournamentId: tournament.id,
        name: 'Homonyme',
        podiumRoster: [{ id: 'b', name: row.name, country: 'FRA', club: 'Club B' }],
      },
    });
    await db.$transaction((tx) =>
      A.ingest(tx, ambiguous, ambiguous.podiumRoster, 'https://www.fencingtimelive.com/events/test'),
    );
    assert.equal((await F.list(db, user.id, ambiguous.id)).links.length, 0);
    assert.ok(other.id);
    const match = await db.match.create({ data: { competitionId: c.id, player1: row.name, player2: 'Adversaire' } });
    const prediction = await db.prediction.create({
      data: { userId: user.id, matchId: match.id, predictedScore1: 15, predictedScore2: 8 },
    });
    await I.importRows(db, [row]);
    assert.deepEqual(await db.prediction.findUnique({ where: { id: prediction.id } }), prediction);
    const unknown = await db.competition.create({
      data: {
        tournamentId: tournament.id,
        name: 'Nouveau tireur',
        podiumRoster: [{ id: 'n', name: 'NOUVEAU Paul', country: 'FRA', club: 'Club N' }],
      },
    });
    await db.$transaction((tx) =>
      A.ingest(tx, unknown, unknown.podiumRoster, 'https://www.fencingtimelive.com/events/test'),
    );
    const newRows = await D.search(db, user.id, { query: 'NOUVEAU Paul', offset: 0 });
    assert.equal(newRows.results.length, 1);
    assert.ok(newRows.results[0].affiliationId);
    assert.equal(newRows.results[0].ageCategory, null);
    const next = await db.competition.create({
      data: {
        tournamentId: tournament.id,
        name: 'Tournoi suivant',
        podiumRoster: [{ id: 'nn', name: 'NOUVEAU Paul', country: 'FRA', club: 'Club N' }],
      },
    });
    await db.$transaction((tx) => A.ingest(tx, next, next.podiumRoster, 'https://www.fencingtimelive.com/events/test'));
    assert.equal((await D.search(db, user.id, { query: 'NOUVEAU Paul', offset: 0 })).results.length, 1);
    assert.equal(await db.followedFencer.count(), 1);
  },
);
