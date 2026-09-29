const { test } = require('node:test');
const assert = require('node:assert/strict');
const { saveCircuits, circuitRanking } = require('../src/services/circuits');
const { invalidateStandings } = require('../src/services/standings');

function db(pointsByTournament) {
  let stored = null;
  const audits = [];
  return {
    audits,
    appSetting: {
      findUnique: async () => (stored ? { value: stored } : null),
      upsert: async ({ create }) => (stored = create.value),
    },
    auditLog: { create: async ({ data }) => audits.push(data) },
    tournament: {
      findMany: async ({ where } = {}) =>
        [1, 2, 3].filter((id) => !where?.id || where.id.in.includes(id)).map((id) => ({ id, name: `Tournoi ${id}` })),
    },
    // Classement de chaque tournoi (standings) : points fournis par tournoi.
    competition: { findMany: async ({ where }) => [{ id: where.tournamentId * 10 }] },
    user: {
      findMany: async () => [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Chloé' },
      ],
    },
    podiumPrediction: { groupBy: async () => [] },
    poolPrediction: { groupBy: async () => [] },
    pointAdjustment: { groupBy: async () => [] },
    challenge: { findMany: async () => [] },
    match: { findMany: async () => [] },
    prediction: {
      groupBy: async ({ where }) => {
        const t = where.match.competitionId.in[0] / 10;
        return Object.entries(pointsByTournament[t] || {}).map(([userId, pts]) => ({
          userId: Number(userId),
          _sum: { pointsEarned: pts, bonusPoints: 0 },
        }));
      },
    },
  };
}

test('circuits are validated, get stable ids and are logged', async () => {
  const d = db({});
  const saved = await saveCircuits(d, [{ name: ' Circuit national ', tournamentIds: [1, 2, 3], dropWorst: 1 }], 9);
  assert.deepEqual(saved, [{ id: 1, name: 'Circuit national', tournamentIds: [1, 2, 3], dropWorst: 1 }]);
  assert.equal(d.audits[0].action, 'Circuits mis à jour');
  await assert.rejects(saveCircuits(d, [{ name: 'X', tournamentIds: [42] }], 9), /tournois existants/);
  await assert.rejects(saveCircuits(d, [{ name: 'X', tournamentIds: [1], dropWorst: 1 }], 9), /entre 0 et 0/);
  await assert.rejects(
    saveCircuits(
      d,
      [
        { name: 'A', tournamentIds: [1] },
        { name: 'a', tournamentIds: [2] },
      ],
      9,
    ),
    /Deux circuits/,
  );
});

test('circuit ranking: sum of each player’s best results, the worst one dropped', async () => {
  invalidateStandings();
  const d = db({ 1: { 1: 30, 2: 10 }, 2: { 1: 5, 2: 40 }, 3: { 1: 25, 3: 12 } });
  await saveCircuits(d, [{ name: 'Circuit', tournamentIds: [1, 2, 3], dropWorst: 1 }], 9);
  const out = await circuitRanking(d, 1);
  // Alice 30+5+25 → 55 (5 retiré) ; Bob 10+40+0 → 50 ; Chloé 0+0+12 → 12.
  assert.deepEqual(
    out.rows.map((r) => [r.name, r.totalPoints, r.rank, r.played]),
    [
      ['Alice', 55, 1, 3],
      ['Bob', 50, 2, 2],
      ['Chloé', 12, 3, 1],
    ],
  );
  assert.deepEqual(
    out.circuit.tournaments.map((t) => t.name),
    ['Tournoi 1', 'Tournoi 2', 'Tournoi 3'],
  );
  await assert.rejects(circuitRanking(d, 7), /introuvable/);
});
