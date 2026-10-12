const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateScope, scopeOfMember, scopedRow } = require('../src/services/delegationScope');
const { rankRows } = require('../src/services/ranking');
test('individual delegation scopes restrict earned points without mutating general standings', () => {
  const rows = [
    {
      id: 1,
      name: 'A',
      matchPoints: 5,
      outsiderPoints: 1,
      poolPoints: 50,
      podiumPoints: 2,
      adjustmentPoints: 7,
      challengePoints: 4,
      totalPoints: 69,
    },
    { id: 2, name: 'B', matchPoints: 3, outsiderPoints: 0, poolPoints: 1, podiumPoints: 8, totalPoints: 12 },
  ];
  const original = JSON.stringify(rows);
  const league = {
    kind: 'PRIVATE',
    members: [
      { userId: 1, predictionScope: 'TABLEAU' },
      { userId: 2, predictionScope: 'PODIUM' },
    ],
  };
  const ranking = rankRows(rows.map((r) => scopedRow(r, scopeOfMember(league, r.id))));
  assert.deepEqual(
    ranking.map((r) => [r.id, r.totalPoints, r.rank]),
    [
      [2, 8, 1],
      [1, 6, 2],
    ],
  );
  assert.equal(JSON.stringify(rows), original);
  assert.equal(scopedRow(rows[0], 'ALL').totalPoints, 69);
  league.members[0].predictionScope = 'ALL';
  assert.equal(scopedRow(rows[0], scopeOfMember(league, 1)).totalPoints, 69);
});
test('legacy membership and clubs retain their current full standings', () => {
  assert.equal(scopeOfMember({ kind: 'PRIVATE', members: [{ userId: 1 }] }, 1), 'ALL');
  assert.equal(scopeOfMember({ kind: 'CLUB', members: [{ userId: 1, predictionScope: 'PODIUM' }] }, 1), 'ALL');
  assert.equal(
    scopeOfMember({ kind: 'PRIVATE', members: [{ userId: 1, predictionScope: 'PODIUM', leftAt: new Date() }] }, 1),
    'ALL',
  );
});
test('invalid preferences are rejected rather than broadening their scope', () => {
  for (const scope of ['TABLEAU', 'PODIUM', 'ALL']) assert.equal(validateScope(scope), scope);
  assert.equal(validateScope(), 'ALL');
  for (const scope of [null, '', 'all', [], {}, 'NONE']) assert.throws(() => validateScope(scope), { status: 400 });
});

test('only an active member can update their own delegation preference', async () => {
  const { setPreference } = require('../src/services/delegationScope');
  const writes = [];
  let league = { id: 3, kind: 'PRIVATE', members: [{ userId: 1 }, { userId: 2, leftAt: new Date() }] };
  const db = {
    league: { findUnique: async () => league },
    leagueMember: {
      updateMany: async (query) => {
        writes.push(query);
        return { count: 1 };
      },
    },
  };
  assert.deepEqual(await setPreference(db, 3, 1, 'PODIUM'), { predictionScope: 'PODIUM' });
  assert.deepEqual(writes[0], { where: { leagueId: 3, userId: 1, leftAt: null }, data: { predictionScope: 'PODIUM' } });
  for (const id of [2, 9]) await assert.rejects(setPreference(db, 3, id, 'TABLEAU'), { status: 403 });
  league.archivedAt = new Date();
  await assert.rejects(setPreference(db, 3, 1, 'TABLEAU'), { status: 403 });
  league = { ...league, archivedAt: null, kind: 'CLUB' };
  await assert.rejects(setPreference(db, 3, 1, 'TABLEAU'), { status: 400 });
  await assert.rejects(setPreference(db, 3, 1, 'INVALID'), { status: 400 });
  assert.equal(writes.length, 1);
});

test('all nonempty section combinations sum only the selected earned points', () => {
  const row = { poolPoints: 10, matchPoints: 20, outsiderPoints: 2, podiumPoints: 30, totalPoints: 62 };
  for (const [scope, points] of [
    ['POOLS', 10],
    ['TABLEAU', 22],
    ['PODIUM', 30],
    ['POOLS,TABLEAU', 32],
    ['POOLS,PODIUM', 40],
    ['TABLEAU,PODIUM', 52],
    ['ALL', 62],
  ]) {
    assert.equal(validateScope(scope), scope);
    assert.equal(scopedRow(row, scope).totalPoints, points);
  }
});
