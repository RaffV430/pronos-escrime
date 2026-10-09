const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, freshDatabase } = require('./helpers');
const { PrismaClient } = require('@prisma/client');
const clubs = require('../../src/services/accountClubs');
const moderation = require('../../src/services/clubModeration');
const { clubMembersAt } = require('../../src/services/groups');
let db;
before(async () => {
  if (url) db = new PrismaClient({ datasourceUrl: await freshDatabase('account_clubs') });
});
after(async () => {
  await db?.$disconnect();
});
const options = { skip: !url && 'TEST_DATABASE_URL non défini' };
async function approvedClub(userId, input) {
  const pending = await clubs.setClub(db, userId, input);
  const admin = await user(`approve-${userId}-${pending.clubRequest.id}`, true);
  await moderation.decide(db, admin.id, pending.clubRequest.id, { status: 'APPROVED' });
  return clubs.profile(db, userId);
}
async function user(name, isAdmin = false) {
  return db.user.create({ data: { name, email: `${name}@example.test`, password: 'test-only', isAdmin } });
}
test(
  'clubs: registration choice, shared league, concurrent joins and missing clubs are idempotent',
  options,
  async () => {
    const [a, b] = await Promise.all([user('club-a'), user('club-b')]);
    const input = { name: 'Club Local Test', city: 'Étampes', shortName: 'CLT' };
    const [pa, pb] = await Promise.all([
      clubs.setClub(db, a.id, input),
      clubs.setClub(db, b.id, { ...input, name: 'club local test' }),
    ]);
    assert.equal(pa.club, null);
    assert.equal(pb.club, null);
    assert.equal(await db.club.count({ where: { nameKey: 'club local test' } }), 0);
    const admin = await user('registration-admin', true);
    await Promise.all([
      moderation.decide(db, admin.id, pa.clubRequest.id, { status: 'APPROVED' }),
      moderation.decide(db, admin.id, pb.clubRequest.id, { status: 'APPROVED' }),
    ]);
    Object.assign(pa, await clubs.profile(db, a.id));
    Object.assign(pb, await clubs.profile(db, b.id));
    assert.equal(pa.club.id, pb.club.id);
    assert.equal(pa.club.leagueId, pb.club.leagueId);
    assert.equal(pa.club.status, 'VERIFIED');
    assert.equal(await db.leagueMember.count({ where: { leagueId: pa.club.leagueId, leftAt: null } }), 2);
    assert.equal((await clubs.setClub(db, a.id, { clubId: pa.club.id })).club.id, pa.club.id);
    assert.equal(await db.leagueMember.count({ where: { leagueId: pa.club.leagueId, userId: a.id } }), 1);
    assert.equal((await clubs.profile(db, a.id)).responsibility, null, 'first member is not a manager');
    await assert.rejects(clubs.setClub(db, a.id, { name: 'Other', city: '' }), { status: 400 });
    assert.equal((await clubs.profile(db, a.id)).club.id, pa.club.id, 'invalid input rolls back');
    await assert.rejects(
      db.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { name: 'rollback', email: 'rollback@example.test', password: 'unused' },
        });
        await clubs.setClubInTransaction(tx, u.id, { clubId: 999999 });
      }),
      { status: 404 },
    );
    assert.equal(await db.user.count({ where: { name: 'rollback' } }), 0, 'signup and membership are atomic');
  },
);
test(
  'club change keeps identifiers, favorites, predictions and frozen membership periods; role cannot be self-approved',
  options,
  async () => {
    const [a, admin] = await Promise.all([user('history'), user('club-admin', true)]);
    const t = await db.tournament.create({ data: { name: 'History' } });
    const c = await db.competition.create({ data: { name: 'Foil', tournamentId: t.id } });
    const m = await db.match.create({ data: { competitionId: c.id, player1: 'A', player2: 'B' } });
    const p = await db.prediction.create({
      data: { userId: a.id, matchId: m.id, predictedScore1: 15, predictedScore2: 12, pointsEarned: 4 },
    });
    const f = await db.followedFencer.create({
      data: {
        userId: a.id,
        identityKey: 'history|fra|',
        name: 'History Fencer',
        country: 'FRA',
        club: '',
        originCompetitionId: c.id,
        originEntryId: 'f',
      },
    });
    const first = await approvedClub(a.id, { name: 'History club', city: 'Paris' });
    await db.leagueMember.update({
      where: { leagueId_userId: { leagueId: first.club.leagueId, userId: a.id } },
      data: { joinedAt: new Date('2026-09-01') },
    });
    await clubs.requestRole(db, a.id, 'Entraîneur du club');
    await assert.rejects(clubs.decideRole(db, a.id, a.id, first.club.id, 'APPROVED'), { status: 403 });
    await clubs.decideRole(db, admin.id, a.id, first.club.id, 'APPROVED');
    assert.equal((await clubs.profile(db, a.id)).responsibility.status, 'APPROVED');
    await clubs.updatePresentation(db, a.id, 'Présentation du club');
    const next = await approvedClub(a.id, { name: 'Next club', city: 'Melun' });
    assert.notEqual(next.club.id, first.club.id);
    assert.equal(
      (await db.clubResponsibility.findUnique({ where: { clubId_userId: { clubId: first.club.id, userId: a.id } } }))
        .status,
      'REVOKED',
    );
    await assert.rejects(clubs.decideRole(db, admin.id, a.id, first.club.id, 'APPROVED'), { status: 409 });
    const periods = await db.leagueMember.findMany({ where: { leagueId: first.club.leagueId } });
    assert.equal(clubMembersAt(periods, '2026-09-15').length, 1);
    assert.equal((await db.prediction.findUnique({ where: { id: p.id } })).pointsEarned, 4);
    assert.equal((await db.followedFencer.findUnique({ where: { id: f.id } })).id, f.id);
    const none = await clubs.setClub(db, a.id, { none: true });
    assert.equal(none.club, null);
    assert.ok(none.clubChoiceAt);
    assert.equal(await db.leagueMember.count({ where: { userId: a.id, leftAt: null } }), 0);
  },
);
test(
  'several admins-approved managers, revoke and directory aliases without inventing missing affiliations',
  options,
  async () => {
    const [a, b, admin] = await Promise.all([user('manager-a'), user('manager-b'), user('manager-admin', true)]);
    const club = (await db.club.findMany()).find((c) => c.shortName === 'CEMVS');
    assert.ok(club, 'CSV was seeded');
    await clubs.setClub(db, a.id, { clubId: club.id });
    await clubs.setClub(db, b.id, { clubId: club.id });
    await Promise.all([
      clubs.decideRole(db, admin.id, a.id, club.id, 'APPROVED'),
      clubs.decideRole(db, admin.id, b.id, club.id, 'APPROVED'),
    ]);
    assert.equal(await db.clubResponsibility.count({ where: { clubId: club.id, status: 'APPROVED' } }), 2);
    await clubs.decideRole(db, admin.id, a.id, club.id, 'REVOKED');
    assert.equal((await clubs.profile(db, a.id)).responsibility.status, 'REVOKED');
    await assert.rejects(clubs.updatePresentation(db, a.id, 'Unauthorized'), { status: 403 });
    const { directory } = require('../../src/services/fencerDirectory');
    const rows = directory(
      [
        {
          id: 1,
          name: 'Foil',
          podiumRoster: [
            { id: 'a', name: 'Known Fencer', country: 'FRA', club: 'cemvs' },
            { id: 'b', name: 'Unknown Fencer', country: 'FRA', club: '' },
          ],
        },
      ],
      [],
      club,
    );
    assert.equal(rows.find((r) => r.name === 'Known Fencer').isClub, true);
    assert.equal(rows.find((r) => r.name === 'Unknown Fencer').isClub, false);
  },
);

test(
  'HTTP clubs: registration requires a valid choice when provided; administration is checked against the current role',
  options,
  async () => {
    process.env.JWT_SECRET = 'account-clubs-tests-only-not-production';
    const prismaPath = require.resolve('../../src/lib/prisma');
    require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: db };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/clubs', require('../../src/routes/accountClubRoutes').createRouter(db));
    app.use('/auth', require('../../src/routes/authRoutes'));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, token) => {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const input = {
        username: 'http-registration',
        email: 'http-registration@example.test',
        password: 'OnlyTests-Password42!',
      };
      const invalid = await call('POST', '/auth/register', { ...input, clubChoice: { clubId: 999999 } });
      assert.equal(invalid.status, 404);
      assert.equal(await db.user.count({ where: { name: input.username } }), 0);
      const valid = await call('POST', '/auth/register', { ...input, clubChoice: { none: true } });
      assert.equal(valid.status, 200);
      const token = valid.body.token;
      assert.equal((await call('GET', '/clubs/admin/responsibilities')).status, 401);
      assert.equal((await call('GET', '/clubs/admin/responsibilities', null, token)).status, 403);
      assert.equal((await call('PUT', '/clubs/me/presentation', { description: 'Unauthorized' }, token)).status, 403);
      const profile = await call('GET', '/clubs/me', null, token);
      assert.ok(profile.body.clubChoiceAt);
      assert.equal(profile.body.club, null);
      await db.user.update({ where: { id: valid.body.user.id }, data: { isAdmin: true } });
      assert.equal(
        (await call('GET', '/clubs/admin/responsibilities', null, token)).status,
        200,
        'current database role wins over an old session claim',
      );
      await db.user.update({ where: { id: valid.body.user.id }, data: { isAdmin: false } });
      assert.equal((await call('GET', '/clubs/admin/responsibilities', null, token)).status, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test('legacy club abbreviation reuses the registry and keeps its membership identity', options, async () => {
  const a = await user('legacy-alias');
  const club = await db.club.findUnique({ where: { nameKey: 'c e versaillais' } });
  const league = await db.league.create({
    data: { name: club.shortName, kind: 'CLUB', ownerId: a.id, code: 'legacy-alias-test', startsAt: new Date() },
  });
  const { enroll } = require('../../src/services/groups');
  const joined = await db.$transaction((tx) => enroll(tx, league, a.id));
  assert.equal((await clubs.profile(db, a.id)).club.id, club.id);
  const chosen = await clubs.setClub(db, a.id, { clubId: club.id });
  assert.equal(chosen.club.leagueId, league.id);
  assert.equal(
    (await db.leagueMember.findUnique({ where: { leagueId_userId: { leagueId: league.id, userId: a.id } } })).id,
    joined.id,
  );
});
