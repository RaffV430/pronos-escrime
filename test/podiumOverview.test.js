// Onglet « Podium » : pronostics de chacun visibles seulement une fois les podiums clos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { podiumOverview } = require('../src/services/podiumOverview');

const roster = ['A', 'B', 'C', 'D', 'E'].map((n) => ({ id: n.toLowerCase(), name: `${n} Tireur`, country: 'FRA' }));
const pick = (userId, name, [g, s, b1, b2], pointsEarned = 0) => ({
  userId,
  competitionId: 1,
  gold: `${g} Tireur`,
  silver: `${s} Tireur`,
  bronze1: `${b1} Tireur`,
  bronze2: `${b2} Tireur`,
  selectionIds: {
    gold: g.toLowerCase(),
    silver: s.toLowerCase(),
    bronze1: b1.toLowerCase(),
    bronze2: b2.toLowerCase(),
  },
  pointsEarned,
  user: { id: userId, name },
});
const competition = (extra = {}) => ({
  id: 1,
  tournamentId: 10,
  name: 'Épée hommes senior',
  podiumFormat: 'INDIVIDUAL',
  podiumRoster: roster,
  ...extra,
});
const db = (c) => ({
  tournament: { findMany: async () => [{ id: 10, name: "Journées de l'épée 2026" }] },
  competition: { findMany: async () => [c] },
  podiumPrediction: {
    findMany: async () => [pick(1, 'Raff', ['A', 'B', 'E', 'C'], 60), pick(2, 'Gru', ['B', 'A', 'C', 'E'], 35)],
  },
  match: { findMany: async () => [] },
});

test('podium pas encore clos : seulement mon pronostic et le nombre de joueurs', async () => {
  const [t] = await podiumOverview(db(competition()), 1);
  const [c] = t.competitions;
  assert.equal(c.closed, false);
  assert.equal(c.players, 2);
  assert.deepEqual(
    c.predictions.map((p) => p.name),
    ['Raff'],
  );
  assert.equal(c.predictions[0].points, null);
});

test('podium clos et officiel : tous les pronostics, points, justesse de chaque choix', async () => {
  const official = {
    gold: 'a',
    silver: 'b',
    bronze1: 'c',
    bronze2: 'd',
    finalConfirmed: true,
  };
  const c = competition({
    officialPodium: official,
    podiumResolvedAt: new Date(),
    resultsVerifiedAt: new Date(),
    rosterSourceUrl: 'https://engarde-service.com/competition/era/jde-2026/ehs/tireurs.htm',
    resultsSourceUrl: 'https://engarde-service.com/competition/era/jde-2026/ehs/clasfinal.htm',
  });
  const [t] = await podiumOverview(db(c), 1);
  const [e] = t.competitions;
  assert.equal(e.closed, true);
  assert.deepEqual(
    e.official.map((o) => o.name),
    ['A Tireur', 'B Tireur', 'C Tireur', 'D Tireur'],
  );
  assert.deepEqual(
    e.predictions.map((p) => [p.name, p.points]),
    [
      ['Raff', 60],
      ['Gru', 35],
    ],
  );
  assert.deepEqual(
    e.predictions[0].picks.map((p) => p.status),
    ['exact', 'exact', 'miss', 'exact'], // deux 3e places : le bon tireur sur l'autre bronze reste juste
  );
  assert.deepEqual(
    e.predictions[1].picks.map((p) => p.status),
    ['podium', 'podium', 'exact', 'miss'],
  );
});
