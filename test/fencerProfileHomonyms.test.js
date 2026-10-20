// Journées de l'épée 2026, épée hommes seniors : deux « ROBERT Julien » (Décines, Perpignan). Une fiche
// par club, jamais fusionnée.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fencerProfile } = require('../src/services/fencerProfile');

const jde = {
  id: 28,
  name: 'Épée Hommes senior',
  createdAt: '2026-10-17',
  tournament: { id: 10, name: "Journées de l'épée 2026" },
  podiumRoster: [
    { id: 'd', name: 'ROBERT Julien', country: 'DECINES TE' },
    { id: 'p', name: 'ROBERT Julien', country: 'PERPIGNAN RO' },
  ],
  officialPodium: {
    classification: [
      { entryId: 'p', rank: 63 },
      { entryId: 'd', rank: 118 },
    ],
  },
};
const other = {
  id: 40,
  name: 'Épée Hommes senior',
  createdAt: '2026-11-07',
  tournament: { id: 12, name: 'Circuit national' },
  podiumRoster: [{ id: 'x', name: 'ROBERT Julien', country: 'PERPIGNAN RO' }],
  officialPodium: null,
};
const match = (id, round, p1, c1, p2, c2, winner, competitionId = 28) => ({
  id,
  competitionId,
  round,
  player1: p1,
  player2: p2,
  club1: c1,
  club2: c2,
  score1: winner === 1 ? 15 : 10,
  score2: winner === 2 ? 15 : 10,
  winner,
  isFinished: true,
  startsAt: '2026-10-17T12:00:00Z',
});
const matches = [
  match(1, 'T256', 'ROBERT Julien', 'DECINES TE', 'HUBERT Thomas', 'DUCOS MSQ', 1),
  match(2, 'T256', 'ROBERT Julien', 'PERPIGNAN RO', 'BRES Nicolas', 'ST PAUL 3CHX', 1),
  match(3, 'T128', 'GENTILE Antoine', 'ST MAUR VGA', 'ROBERT Julien', 'DECINES TE', 1),
  match(4, 'T128', 'DRION Andeol', 'LEVALLOIS', 'ROBERT Julien', 'PERPIGNAN RO', 2),
  match(5, 'T64', 'ROBERT Julien', 'PERPIGNAN RO', 'LERUS ROULEZ Hendrick', 'BEAUVAIS ACA', 2),
];
const pool = (id, name, club, other) => ({
  pool: {
    id,
    name: `Poule ${id}`,
    competitionId: 28,
    bouts: [
      [null, 'V5'],
      ['D2', null],
    ],
    fencers: [
      { id: id * 10, name: 'ROBERT Julien', club, position: 1, wins: 1, losses: 0, indicator: 3 },
      { id: id * 10 + 1, name: other, club: 'X', position: 2, wins: 0, losses: 1, indicator: -3 },
    ],
  },
});
const db = {
  match: { findMany: async () => matches },
  poolFencer: { findMany: async () => [pool(18, 'R', 'DECINES TE', 'A'), pool(29, 'R', 'PERPIGNAN RO', 'B')] },
  $queryRaw: async () => [{ id: 28 }, { id: 40 }],
  competition: { findMany: async ({ where }) => [jde, other].filter((c) => where.id.in.includes(c.id)) },
};

test('homonymes de clubs différents : choix du club, aucun parcours fusionné', async () => {
  const out = await fencerProfile(db, 'ROBERT Julien');
  assert.deepEqual(out.homonyms, [
    { club: 'DECINES TE', competitions: 1 },
    { club: 'PERPIGNAN RO', competitions: 2 },
  ]);
  assert.deepEqual(out.competitions, []);
});

test('fiche du ROBERT Julien de Décines : sa poule, ses matchs, sa place', async () => {
  const out = await fencerProfile(db, 'ROBERT Julien', { club: 'decines te' });
  assert.equal(out.country, 'DECINES TE');
  assert.deepEqual(
    out.competitions.map((c) => c.competitionId),
    [28],
  );
  const [c] = out.competitions;
  assert.deepEqual(
    c.pools.map((p) => p.pool),
    ['Poule 18'],
  );
  assert.deepEqual(c.tableau.map((m) => m.matchId).sort(), [1, 3]);
  assert.equal(c.result.round, 'T128');
  assert.deepEqual(out.summary, { competitions: 1, poolWins: 1, poolLosses: 0, tableauWins: 1, tableauLosses: 1 });
});

test('fiche du ROBERT Julien de Perpignan : ses épreuves seulement ; ouverte depuis un de ses matchs', async () => {
  const out = await fencerProfile(db, 'ROBERT Julien', { matchId: 4 });
  assert.equal(out.club, 'PERPIGNAN RO');
  assert.deepEqual(out.competitions.map((c) => c.competitionId).sort(), [28, 40]);
  const c = out.competitions.find((x) => x.competitionId === 28);
  assert.deepEqual(
    c.pools.map((p) => p.pool),
    ['Poule 29'],
  );
  assert.deepEqual(c.tableau.map((m) => m.matchId).sort(), [2, 4, 5]);
  assert.equal(c.result.round, 'T64');
});
