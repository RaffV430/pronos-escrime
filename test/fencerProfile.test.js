const test = require('node:test');
const assert = require('node:assert/strict');
const { poolLine, bout, finalPlace, fencerProfile } = require('../src/services/fencerProfile');

const pool = {
  id: 1,
  name: 'Poule 3',
  startsAt: '2026-09-26T08:00:00Z',
  bouts: [
    [null, 'V5', 'D2', 'V'],
    ['D4', null, 'V5', 'D1'],
    ['V5', 'D3', null, 'V4'],
    ['D3', 'V5', 'D2', null],
  ],
  fencers: [
    { id: 10, name: 'A Ana', position: 1, wins: 2, losses: 1, indicator: 2, countryCode: 'FRA' },
    { id: 11, name: 'B Bea', position: 2, wins: 1, losses: 2, indicator: -3 },
    { id: 12, name: 'C Cia', position: 3, wins: 2, losses: 1, indicator: 4 },
    { id: 13, name: 'D Dea', position: 4, wins: 1, losses: 2, indicator: -3 },
  ],
};

test('assaut lu dans la matrice, touches de la victoire déduites (V seul = 5)', () => {
  assert.deepEqual(bout(pool.bouts, 0, 1), { won: true, given: 5, received: 4 });
  assert.deepEqual(bout(pool.bouts, 0, 3), { won: true, given: 5, received: 3 });
  assert.deepEqual(bout(pool.bouts, 2, 3), { won: true, given: 4, received: 2 });
  assert.equal(
    bout(
      [
        [null, 'V5'],
        [null, null],
      ],
      0,
      1,
    ),
    null,
    'assaut à moitié publié ignoré',
  );
});

test('ligne de poule : bilan, place et chaque assaut (nom insensible à la casse)', () => {
  const line = poolLine(pool, 'a ana');
  assert.equal(line.place, 2);
  assert.deepEqual(
    line.bouts.map((b) => [b.opponent, b.won, b.given, b.received]),
    [
      ['B Bea', true, 5, 4],
      ['C Cia', false, 2, 5],
      ['D Dea', true, 5, 3],
    ],
  );
  assert.equal(poolLine(pool, 'Inconnu'), null);
  assert.deepEqual(poolLine({ ...pool, bouts: null }, 'A Ana').bouts, []);
});

test('place finale : podium officiel, sinon tour de la dernière défaite', () => {
  const c = { podiumRoster: [{ id: 'x', name: 'A Ana' }], officialPodium: { gold: 'x' } };
  assert.deepEqual(finalPlace(c, 'A ANA', []), { place: 1, label: 'Vainqueur' });
  const out = finalPlace({}, 'B Bea', [
    { round: 'T32', won: true },
    { round: 'T16', won: false },
  ]);
  assert.equal(out.label, 'Éliminé en T16');
});

test('fiche : épreuves les plus récentes en premier, bilans cumulés', async () => {
  const match = (id, competitionId, round, p1, p2, s1, s2, startsAt) => ({
    id,
    competitionId,
    round,
    player1: p1,
    player2: p2,
    player1Country: 'FRA',
    player2Country: 'ITA',
    score1: s1,
    score2: s2,
    winner: s1 > s2 ? 1 : 2,
    isFinished: true,
    startsAt,
    competition: { id: competitionId, name: 'Épreuve', tournament: { id: 1, name: 'Tournoi' } },
  });
  const db = {
    match: {
      findMany: async () => [
        match(1, 5, 'T32', 'A Ana', 'X', 15, 3, '2026-09-26T12:00:00Z'),
        match(2, 5, 'T16', 'Y', 'A Ana', 15, 12, '2026-09-26T14:00:00Z'),
        match(3, 6, 'T8', 'A Ana', 'Z', 15, 9, '2026-10-04T12:00:00Z'),
      ],
    },
    poolFencer: { findMany: async () => [{ pool: { ...pool, competitionId: 5 } }] },
    competition: {
      findMany: async () => [
        {
          id: 5,
          name: 'Fleuret',
          createdAt: '2026-09-01',
          podiumRoster: [],
          officialPodium: null,
          tournament: { id: 1, name: 'T1' },
        },
        {
          id: 6,
          name: 'Fleuret',
          createdAt: '2026-10-01',
          podiumRoster: [],
          officialPodium: null,
          tournament: { id: 2, name: 'T2' },
        },
      ],
    },
  };
  const out = await fencerProfile(db, 'A Ana');
  assert.equal(out.country, 'FRA');
  assert.deepEqual(
    out.competitions.map((c) => c.competitionId),
    [6, 5],
  );
  assert.deepEqual(out.summary, { competitions: 2, poolWins: 2, poolLosses: 1, tableauWins: 2, tableauLosses: 1 });
  const first = out.competitions[1];
  assert.equal(first.result.label, 'Éliminé en T16');
  assert.deepEqual(
    first.tableau.map((m) => m.round),
    ['T32', 'T16'],
  );
  await assert.rejects(fencerProfile(db, ' '), /invalide/);
});
