const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseNextPrediction } = require('../src/services/nextPrediction');
const now = Date.parse('2026-10-15T12:00:00Z');
const tournament = { id: 7, name: 'TEST CUP' };
const match = (id, round, startsAt, extra = {}) => ({
  id,
  competitionId: 20,
  round,
  startsAt,
  isFinished: false,
  ...extra,
});
const rounds = [
  { competitionId: 20, round: 'J1:T64', expectedMatchCount: 1 },
  { competitionId: 20, round: 'T64', expectedMatchCount: 1 },
];
const men = {
  id: 20,
  name: 'TEST MEN',
  tournament,
  pools: [],
  matches: [match(1, 'J1:T64', '2026-10-15T07:00:00Z', { isFinished: true }), match(2, 'T64', '2026-10-17T00:00:00Z')],
};
test('J1 fini : la carte propose le principal avec son horaire et sa phase', () => {
  const before = structuredClone(men);
  const next = chooseNextPrediction([men], new Map(), rounds, now);
  assert.equal(next.phase, 'main');
  assert.equal(next.view, 'tableau');
  assert.equal(next.startsAt, '2026-10-17T00:00:00.000Z');
  assert.deepEqual(men, before);
});
test('une épreuve dames ouverte plus tôt passe avant le J2 hommes', () => {
  const women = {
    id: 21,
    name: 'TEST WOMEN',
    tournament,
    matches: [],
    pools: [
      { startsAt: '2026-10-16T00:00:00Z', closesAt: '2026-10-16T00:00:00Z', lockMode: 'FIRST_RESULT', fencers: [{}] },
    ],
  };
  const configs = new Map([[21, { date: '2026-10-16', time: '09:00', timezone: 'Asia/Tokyo' }]]);
  const next = chooseNextPrediction([men, women], configs, rounds, now);
  assert.equal(next.id, 21);
  assert.equal(next.view, 'poules');
});
test('pas de proposition fermée, ambiguë ou inventée avant publication', () => {
  assert.equal(chooseNextPrediction([{ ...men, matches: [men.matches[0]] }], new Map(), rounds, now), null);
  assert.equal(
    chooseNextPrediction(
      [{ ...men, matches: [{ ...men.matches[1], liveDetectedAt: new Date(now) }] }],
      new Map(),
      rounds,
      now,
    ),
    null,
  );
  assert.equal(chooseNextPrediction([{ ...men, matches: [men.matches[1]] }], new Map(), [], now), null);
});
