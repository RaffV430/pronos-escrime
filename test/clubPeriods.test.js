const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clubMembersAt, enroll } = require('../src/services/groups');

test('rejoining preserves both membership periods and the gap between them', async () => {
  let member = { id: 8, userId: 7, joinedAt: new Date('2026-09-01'), leftAt: new Date('2026-09-10') };
  let locks = 0;
  const tx = {
    $queryRaw: async () => {
      locks++;
    },
    club: { findFirst: async () => ({ id: 1 }) },
    user: { update: async () => ({}) },
    leagueMember: {
      findFirst: async () => null,
      findUnique: async () => member,
      upsert: async ({ update }) => (member = { ...member, ...update }),
    },
  };
  await enroll(tx, { id: 2, kind: 'CLUB' }, 7);
  assert.equal(locks, 2);
  assert.equal(member.membershipPeriods.length, 1);
  assert.equal(clubMembersAt([member], '2026-09-05').length, 1);
  assert.equal(clubMembersAt([member], '2026-09-15').length, 0);
  const joined = member.joinedAt;
  await enroll(tx, { id: 2, kind: 'CLUB' }, 7);
  assert.equal(member.joinedAt, joined, 'an already active member keeps their start date');
  assert.equal(member.membershipPeriods.length, 1);
});
test('legacy club league consolidation preserves a gap between membership periods', () => {
  const { mergePeriods } = require('../src/services/groups');
  const member = mergePeriods([
    { joinedAt: '2026-09-01', leftAt: '2026-09-10' },
    { joinedAt: '2026-10-01', leftAt: null },
  ]);
  assert.equal(clubMembersAt([member], '2026-09-05').length, 1);
  assert.equal(clubMembersAt([member], '2026-09-15').length, 0);
});

test('membership migration is accepted by the actual migration loader', () => {
  const { pending, statements } = require('../src/services/migrations');
  const migration = pending().find((m) => m.file === '202610071000_club_membership_periods.sql');
  assert.ok(migration);
  assert.equal(statements(migration.sql).length, 1);
});
