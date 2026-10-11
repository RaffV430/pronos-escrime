const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../src/services/adminReview');
const { applyPool } = require('../src/services/ftlPools');
const { namedEntries } = require('../src/services/ftlParser');

test('a duplicate entry set aside by the administration is ignored by name lookups', () => {
  const roster = [
    { id: 'A', name: 'BONIFACE Ludrick', active: false },
    { id: 'B', name: 'BONIFACE Ludrick', entryRanking: 1070 },
    { id: 'C', name: 'DURAND Paul' },
  ];
  assert.deepEqual(
    namedEntries(roster, 'Boniface Ludrick').map((e) => e.id),
    ['B'],
  );
  assert.equal(
    namedEntries(
      roster.map((e) => ({ ...e, active: true })),
      'BONIFACE Ludrick',
    ).length,
    2,
  );
});

function fakeDb(state) {
  const tx = {
    $queryRaw: async () => [],
    competition: {
      findUnique: async () => state.competition,
      update: async ({ data }) => Object.assign(state.competition, data),
    },
    match: {
      findUnique: async () => state.match,
      update: async ({ data }) => Object.assign(state.match, data),
    },
    prediction: {
      findMany: async () => state.predictions,
      update: async ({ where, data }) =>
        Object.assign(
          state.predictions.find((p) => p.id === where.id),
          data,
        ),
      updateMany: async ({ data }) => {
        state.predictions.forEach((p) => Object.assign(p, data));
        return { count: state.predictions.length };
      },
    },
    auditLog: { create: async ({ data }) => state.logs.push(data) },
  };
  return { ...tx, $transaction: async (fn) => fn(tx) };
}

test('keeping one duplicate entry sets the others aside', async () => {
  const state = {
    logs: [],
    competition: {
      id: 15,
      podiumRoster: [
        { id: 'A', name: 'BONIFACE Ludrick' },
        { id: 'B', name: 'BONIFACE Ludrick', entryRanking: 1070 },
        { id: 'C', name: 'DURAND Paul' },
      ],
    },
  };
  const out = await review.keepEntry(fakeDb(state), 15, 'B', 1);
  assert.deepEqual(out.discarded, ['A']);
  assert.deepEqual(
    state.competition.podiumRoster.map((e) => e.active),
    [false, true, undefined],
  );
  await assert.rejects(review.keepEntry(fakeDb(state), 15, 'C', 1), /Aucune autre/);
});

test('a cancelled pairing gives only the winner point to correct picks', async () => {
  const state = {
    logs: [],
    match: {
      id: 1236,
      resultType: 'CANCELLED',
      syncIssue: 'annulée',
      player1: 'GIRONDIN Noah',
      player2: 'BOUMAZA Mahel',
    },
    predictions: [
      { id: 1, predictedScore1: 10, predictedScore2: 15, pointsEarned: 0, bonusPoints: 0 },
      { id: 2, predictedScore1: 15, predictedScore2: 12, pointsEarned: 0, bonusPoints: 0 },
      { id: 3, predictedScore1: 8, predictedScore2: 15, pointsEarned: 0, bonusPoints: 2 },
    ],
  };
  const out = await review.awardWinner(fakeDb(state), 1236, 2, 1);
  assert.equal(out.awarded, 2);
  assert.deepEqual(
    state.predictions.map((p) => [p.pointsEarned, p.bonusPoints]),
    [
      [1, 0],
      [0, 0],
      [1, 0],
    ],
  );
  assert.equal(state.match.syncIssue, null);
  await assert.rejects(review.awardWinner(fakeDb(state), 1236, 2, 1), /plus en attente/);
});

test('an official sheet without the set-aside fencer still updates the others', async () => {
  const fencers = [
    { id: 1, name: 'A', position: 1 },
    { id: 2, name: 'B', position: 2, status: 'ABSENT' },
    { id: 3, name: 'C', position: 3 },
  ];
  const pool = {
    id: 9,
    competitionId: 1,
    sourceUrl: 'u',
    sourcePoolNumber: 32,
    lockMode: 'FIRST_RESULT',
    isLocked: false,
    isFinal: false,
    name: 'Poule 32',
    fencers,
  };
  const updates = [];
  let zeroed = null;
  const tx = {
    $queryRaw: async () => [],
    pool: { findUnique: async () => pool, update: async () => pool },
    poolFencer: { updateMany: async ({ where, data }) => (updates.push([where.id, data]), { count: 1 }) },
    poolPrediction: {
      findMany: async () => [],
      updateMany: async ({ where }) => ((zeroed = where.fencerId.in), { count: 0 }),
    },
  };
  const observed = {
    complete: true,
    rows: [
      { name: 'A', position: 1, hasResult: true, wins: 1, losses: 0, indicator: 3 },
      { name: 'C', position: 2, hasResult: true, wins: 0, losses: 1, indicator: -3 },
    ],
  };
  const out = await applyPool(tx, pool, observed, new Date());
  assert.equal(out.finalized, 1);
  assert.deepEqual(updates.map(([id]) => id).sort(), [1, 3]);
  assert.deepEqual(zeroed, [2]);
  const plain = { ...pool, fencers: fencers.map((f) => ({ ...f, status: null })) };
  await assert.rejects(
    applyPool(
      { ...tx, pool: { findUnique: async () => plain, update: async () => plain } },
      plain,
      observed,
      new Date(),
    ),
    /Composition officielle différente/,
  );
});
