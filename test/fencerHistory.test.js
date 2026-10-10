const test = require('node:test');
const assert = require('node:assert/strict');
const { history } = require('../src/services/fencerHistory');
const favorite = { id: 1, userId: 7, name: 'A', country: 'FRA', originCompetitionId: 10, originEntryId: 'a' };
const competition = {
  id: 10,
  name: 'Fleuret',
  podiumFormat: 'INDIVIDUAL',
  createdAt: new Date('2026-01-01'),
  tournament: { id: 2, name: 'Épreuve archivée', archivedAt: new Date() },
  podiumRoster: [{ id: 'a', name: 'A', nation: 'FRA' }],
  resultsVerifiedAt: new Date(),
  officialPodium: { finalConfirmed: true, classification: [{ entryId: 'a', rank: 5 }] },
};
function db({ owner = true, ambiguous = false } = {}) {
  return {
    followedFencer: { findFirst: async ({ where }) => (where.userId === 7 && owner ? favorite : null) },
    competition: {
      findMany: async () => [
        {
          ...competition,
          podiumRoster: ambiguous
            ? [...competition.podiumRoster, { id: 'b', name: 'A', nation: 'FRA' }]
            : competition.podiumRoster,
        },
      ],
    },
    match: {
      findMany: async () => [
        {
          id: 3,
          player1: 'A',
          player2: 'B',
          isFinished: true,
          winner: 2,
          startsAt: '2026-01-01T10:00:00Z',
          round: 'T16',
        },
      ],
    },
    pool: { findMany: async () => [{ id: 8, fencers: [{ name: 'A', wins: 1 }], startsAt: '2026-01-01T08:00:00Z' }] },
  };
}
test('history includes archived event, all relevant rounds and verified rank', async () => {
  const r = await history(db(), 7, 1);
  assert.equal(r.event.tournament.name, 'Épreuve archivée');
  assert.equal(r.rank.rank, 5);
  assert.equal(r.matches.length, 1);
  assert.equal(r.pools.length, 1);
});
test('another account cannot read favorite history', async () => {
  await assert.rejects(history(db(), 6, 1), (e) => e.status === 404);
});
test('name-only matches are withheld for homonyms', async () => {
  assert.equal((await history(db({ ambiguous: true }), 7, 1)).event, null);
});
