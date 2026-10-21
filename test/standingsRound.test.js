// Classement d'un seul tour d'une épreuve : voir où s'est fait l'écart (poules, T64, podium…).
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStandings } = require('../src/services/standings');

const matches = [
  { id: 1, competitionId: 28, round: 'T64' },
  { id: 2, competitionId: 28, round: 'T32' },
];
const predictions = [
  { userId: 1, matchId: 1, pointsEarned: 10, bonusPoints: 2 },
  { userId: 2, matchId: 2, pointsEarned: 7, bonusPoints: 0 },
];
const db = {
  competition: { findMany: async () => [{ id: 28 }] },
  user: {
    findMany: async () => [
      { id: 1, name: 'Raff' },
      { id: 2, name: 'Gru' },
    ],
  },
  podiumPrediction: { findMany: async () => [{ userId: 2, competitionId: 28, pointsEarned: 30 }] },
  prediction: {
    findMany: async ({ where }) =>
      predictions.filter(
        (p) => !where.match?.round || matches.find((m) => m.id === p.matchId).round === where.match.round,
      ),
  },
  poolPrediction: { findMany: async () => [{ userId: 1, pointsEarned: 5 }] },
  pointAdjustment: { findMany: async () => [{ userId: 1, points: 100 }] },
  challenge: { findMany: async () => [] },
  match: { findMany: async () => [] },
};
const points = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.totalPoints]));

test('classement d’une épreuve : tout, puis un seul tour', async () => {
  assert.deepEqual(points(await computeStandings(db, { competitionId: 28 })), { Raff: 117, Gru: 37 });
  assert.deepEqual(points(await computeStandings(db, { competitionId: 28, round: 'T64' })), { Raff: 12, Gru: 0 });
  assert.deepEqual(points(await computeStandings(db, { competitionId: 28, round: 'T32' })), { Raff: 0, Gru: 7 });
  assert.deepEqual(points(await computeStandings(db, { competitionId: 28, round: 'pools' })), { Raff: 5, Gru: 0 });
  assert.deepEqual(points(await computeStandings(db, { competitionId: 28, round: 'podium' })), { Raff: 0, Gru: 30 });
});

test('tour inconnu ou hors épreuve : ignoré (classement complet)', async () => {
  assert.deepEqual(points(await computeStandings(db, { competitionId: 28, round: 'DROP TABLE' })), {
    Raff: 117,
    Gru: 37,
  });
  assert.deepEqual(points(await computeStandings(db, { tournamentId: 10, round: 'T64' })), { Raff: 117, Gru: 37 });
});
