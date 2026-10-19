// Samsun (24-25/09/2026) : épreuves dont seul le podium avait été enregistré. Un tireur de la liste
// officielle des engagés doit quand même voir l'épreuve dans sa fiche, avec sa place si elle est connue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fencerProfile } = require('../src/services/fencerProfile');

const comps = {
  4: {
    id: 4,
    name: 'Fleuret juniors dames',
    createdAt: '2026-09-26',
    tournament: { id: 1, name: 'Samsun' },
    podiumRoster: [{ id: 'a', name: 'ROBINET Lucas', country: 'FRA' }],
    officialPodium: null,
  },
  3: {
    id: 3,
    name: 'Fleuret juniors hommes',
    createdAt: '2026-09-25',
    tournament: { id: 1, name: 'Samsun' },
    podiumRoster: [
      { id: 'r', name: 'ROBINET Lucas', country: 'FRA' },
      { id: 'g', name: 'GRAHAM Roy', country: 'USA' },
    ],
    officialPodium: {
      gold: 'g',
      classification: [
        { entryId: 'g', rank: 1 },
        { entryId: 'r', rank: 37 },
      ],
    },
  },
  8: {
    id: 8,
    name: 'Fleuret cadets',
    createdAt: '2026-09-24',
    tournament: { id: 1, name: 'Samsun' },
    podiumRoster: [{ id: 'x', name: 'ROBINET Lucas', country: 'BEL' }],
    officialPodium: null,
  },
};
const db = (registered, core = []) => ({
  match: { findMany: async () => core },
  poolFencer: { findMany: async () => [] },
  $queryRaw: async () => registered.map((id) => ({ id })),
  competition: { findMany: async ({ where }) => where.id.in.map((id) => comps[id]).filter(Boolean) },
});
const played = {
  id: 1,
  competitionId: 4,
  round: 'T32',
  player1: 'ROBINET Lucas',
  player2: 'X',
  score1: 15,
  score2: 3,
  winner: 1,
  isFinished: true,
  startsAt: '2026-09-26T10:00:00Z',
  player1Country: 'FRA',
};

test('épreuve connue par la liste des engagés seulement : présente, avec la place du classement officiel', async () => {
  const out = await fencerProfile(db([3, 4], [played]), 'ROBINET Lucas');
  const samsun = out.competitions.find((c) => c.competitionId === 3);
  assert.ok(samsun, 'Fleuret juniors hommes absent de la fiche');
  assert.equal(samsun.detailMissing, true);
  assert.deepEqual(samsun.result, { place: 37, label: '37e' });
  assert.deepEqual(samsun.pools, []);
  assert.equal(out.summary.competitions, 2);
});

test('homonyme d’une autre nation dans une liste d’engagés : écarté, jamais fusionné', async () => {
  const out = await fencerProfile(db([3, 4, 8], [played]), 'ROBINET Lucas');
  assert.deepEqual(out.competitions.map((c) => c.competitionId).sort(), [3, 4]);
});
