const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, freshDatabase } = require('./helpers');
const { PrismaClient } = require('@prisma/client');
const { enroll, leave, clubMembersAt } = require('../../src/services/groups');
let db;
before(async () => {
  if (url) db = new PrismaClient({ datasourceUrl: await freshDatabase('club_periods') });
});
after(async () => {
  await db?.$disconnect();
});
test(
  'real PostgreSQL: membership history survives rejoining and concurrent club joins serialize',
  { skip: !url && 'TEST_DATABASE_URL non défini' },
  async () => {
    const user = await db.user.create({
      data: { name: 'Club test', email: 'club-periods@example.test', password: 'unused' },
    });
    const a = await db.league.create({
      data: { name: 'A', code: 'CLUB-A', kind: 'CLUB', startsAt: new Date(), ownerId: user.id },
    });
    const b = await db.league.create({
      data: { name: 'B', code: 'CLUB-B', kind: 'CLUB', startsAt: new Date(), ownerId: user.id },
    });
    await db.leagueMember.create({
      data: { leagueId: a.id, userId: user.id, joinedAt: new Date('2026-09-01'), leftAt: new Date('2026-09-10') },
    });
    await db.$transaction((tx) => enroll(tx, a, user.id));
    let members = await db.leagueMember.findMany({ where: { leagueId: a.id } });
    assert.equal(clubMembersAt(members, '2026-09-05').length, 1);
    assert.equal(clubMembersAt(members, '2026-09-15').length, 0);
    await db.$transaction((tx) => leave(tx, a, user.id));
    const results = await Promise.allSettled(
      [a, b].map((league) => db.$transaction((tx) => enroll(tx, league, user.id))),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await db.leagueMember.count({ where: { userId: user.id, leftAt: null } }), 1);
    members = await db.leagueMember.findMany({ where: { leagueId: a.id } });
    assert.equal(clubMembersAt(members, '2026-09-15').length, 0);
  },
);
