const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, freshDatabase } = require('./helpers');
const A = require('../../src/services/fencerAffiliations');
const F = require('../../src/services/fencerFollows');
process.env.JWT_SECRET ||= 'affiliation-local-integration-test-secret-only';
let db;
before(async () => {
  if (url) {
    process.env.DATABASE_URL = await freshDatabase('affiliation_regression');
    db = require('../../src/lib/prisma');
  }
});
after(async () => {
  await db?.$disconnect();
});
test(
  'classements : clubs, favoris et pronostics conservés, source vide/ancienne, correction et verrouillage',
  { skip: !url },
  async () => {
    const user = await db.user.create({
      data: { name: 'Test', email: 'affiliation@test.invalid', password: 'unused' },
    });
    const t = await db.tournament.create({ data: { name: 'Test' } });
    const c = await db.competition.create({
      data: {
        name: 'M17',
        tournamentId: t.id,
        podiumRoster: [{ id: 'a', name: 'MARTIN Léa', country: 'FRA', club: 'Ancien club' }],
      },
    });
    const j = await db.competition.create({
      data: {
        name: 'M20',
        tournamentId: t.id,
        podiumRoster: [{ id: 'b', name: 'MARTIN Lea', country: 'FRA', club: 'Nouveau club' }],
      },
    });
    const favorite = await F.follow(db, user.id, c.id, 'a');
    const match = await db.match.create({ data: { competitionId: c.id, player1: 'MARTIN Léa', player2: 'Autre' } });
    const prediction = await db.prediction.create({
      data: { userId: user.id, matchId: match.id, predictedScore1: 15, predictedScore2: 8 },
    });
    const row = {
      name: 'MARTIN Lea',
      country: 'FRA',
      club: 'Nouveau club',
      clubCode: '28092250',
      unique: true,
      sourceUrl: 'FFE_RANKING:' + 'a'.repeat(64) + ':2',
      observedAt: new Date(Date.now() - 60000),
    };
    const imported = await A.federationImport(db, [row], user.id);
    assert.equal(imported.applied.length, 1);
    assert.equal((await F.list(db, user.id, j.id)).links[0].favoriteId, favorite.id);
    assert.equal((await F.follow(db, user.id, j.id, 'b')).id, favorite.id);
    let p = await db.fencerAffiliation.findUnique({ where: { id: imported.applied[0].id } });
    await db.$transaction((tx) => A.observe(tx, p, { club: '', sourceUrl: row.sourceUrl, observedAt: new Date() }));
    assert.equal((await db.fencerAffiliation.findUnique({ where: { id: p.id } })).club, 'Nouveau club');
    p = await A.manual(
      db,
      p.id,
      { club: 'Corrigé', clubCode: '27075011', reason: 'Correction test', revision: p.revision, locked: true },
      user.id,
    );
    await db.$transaction((tx) =>
      A.observe(tx, p, {
        club: 'Autre club',
        sourceUrl: 'https://www.fencingtimelive.com/events/test',
        observedAt: new Date(Date.now() + 1000),
      }),
    );
    assert.equal((await db.fencerAffiliation.findUnique({ where: { id: p.id } })).club, 'Corrigé');
    await assert.rejects(
      () => A.manual(db, p.id, { club: 'Incorrect', reason: 'Test conflit', revision: 0, locked: false }, user.id),
      (e) => e.status === 409,
    );
    p = await A.manual(
      db,
      p.id,
      { club: 'Corrigé', clubCode: '27075011', reason: 'Déverrouillage', revision: p.revision, locked: false },
      user.id,
    );
    p = await db.$transaction((tx) =>
      A.observe(tx, p, {
        club: 'Dernier club',
        sourceUrl: 'https://www.fencingtimelive.com/events/test',
        observedAt: new Date(Date.now() + 2000),
      }),
    );
    await db.$transaction((tx) => A.observe(tx, p, row));
    assert.equal((await db.fencerAffiliation.findUnique({ where: { id: p.id } })).club, 'Dernier club');
    assert.deepEqual(await db.prediction.findUnique({ where: { id: prediction.id } }), prediction);
    assert.deepEqual((await db.competition.findUnique({ where: { id: c.id } })).podiumRoster, c.podiumRoster);
    assert.equal(await db.followedFencer.count({ where: { userId: user.id } }), 1);
    const before = await db.fencerAffiliation.count();
    await assert.rejects(() => A.federationImport(db, [{ ...row, sourceUrl: 'https://malicious.invalid' }], user.id));
    assert.equal(await db.fencerAffiliation.count(), before);
    const hom = await db.competition.create({
      data: {
        name: 'Homonymes',
        tournamentId: t.id,
        podiumRoster: [
          { id: 'h1', name: 'DUPONT Lea', country: 'FRA' },
          { id: 'h2', name: 'DUPONT Lea', country: 'FRA' },
        ],
      },
    });
    assert.ok(hom.id);
    assert.equal((await A.federationImport(db, [{ ...row, name: 'DUPONT Lea' }], user.id)).unresolved.length, 1);
    const catalog = require('../../src/services/ffeRankingImport');
    const clubRows = [
      { code: '0702B004', name: 'Bastia test' },
      { code: '28092250', name: 'BLR92' },
    ];
    assert.equal((await catalog.catalog(db, clubRows)).created, 1);
    assert.equal((await catalog.catalog(db, clubRows)).created, 0);
    assert.equal(await db.club.count({ where: { federationCode: '28092250' } }), 1);
  },
);
test(
  'HTTP affiliations : accès privé, rôle administrateur actuel et données invalides refusées',
  { skip: !url },
  async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/affiliations', require('../../src/routes/fencerAffiliationRoutes').createRouter(db));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const member = await db.user.create({
        data: { name: 'Membre', email: 'member-affiliation@test.invalid', password: 'unused' },
      });
      const admin = await db.user.create({
        data: { name: 'Admin', email: 'admin-affiliation@test.invalid', password: 'unused', isAdmin: true },
      });
      const token = require('../../src/services/session').issueToken;
      const call = (path, user, method = 'GET', body) =>
        fetch(`http://127.0.0.1:${server.address().port}/affiliations${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      assert.equal((await call('?q=Martin')).status, 401);
      assert.equal((await call('?q=Martin', member)).status, 403);
      assert.equal((await call('?q=Martin', admin)).status, 200);
      const p = await db.fencerAffiliation.findFirst();
      assert.equal(
        (
          await call(`/${p.id}`, admin, 'PUT', {
            club: '',
            reason: 'Invalid test',
            locked: false,
            revision: p.revision,
          })
        ).status,
        400,
      );
      assert.equal((await call(`/${p.id}/history`, admin)).status, 200);
      await db.user.update({ where: { id: admin.id }, data: { isAdmin: false } });
      assert.equal((await call('?q=Martin', admin)).status, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
