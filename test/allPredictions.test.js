const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET ||= 'x'.repeat(40);

// « Mes pronostics » toutes épreuves : seules les épreuves où le joueur a pronostiqué, les siennes uniquement.
test('GET /me/predictions/all groups the player’s predictions by event', async (t) => {
  const future = new Date(Date.now() + 86400e3);
  const past = new Date(Date.now() - 86400e3);
  const competitions = [
    {
      id: 5,
      name: 'Fleuret hommes',
      podiumFormat: 'INDIVIDUAL',
      podiumRoster: [],
      tournament: { id: 9, name: 'Challenge de Paris', archivedAt: null },
    },
    {
      id: 6,
      name: 'Sabre dames',
      podiumFormat: 'INDIVIDUAL',
      podiumRoster: [],
      tournament: { id: 3, name: 'Coupe de Lyon', archivedAt: past },
    },
  ];
  const matches = {
    5: [
      {
        id: 1,
        competitionId: 5,
        player1: 'A',
        player2: 'B',
        round: 'T8',
        startsAt: future,
        isFinished: false,
        predictions: [{ userId: 7, predictedScore1: 15, predictedScore2: 10 }],
      },
      {
        id: 2,
        competitionId: 5,
        player1: 'C',
        player2: 'D',
        round: 'T8',
        startsAt: future,
        isFinished: false,
        predictions: [],
      },
    ],
    6: [
      {
        id: 3,
        competitionId: 6,
        player1: 'E',
        player2: 'F',
        round: 'T4',
        startsAt: past,
        isFinished: true,
        score1: 15,
        score2: 12,
        winner: 1,
        predictions: [{ userId: 7, predictedScore1: 15, predictedScore2: 12, pointsEarned: 5, bonusPoints: 0 }],
      },
    ],
  };
  const seen = [];
  const own = (where) => seen.push(where.userId);
  const db = {
    user: { findUnique: async () => ({ sessionVersion: 0 }) },
    prediction: {
      findMany: async ({ where }) => (own(where), [{ match: { competitionId: 5 } }, { match: { competitionId: 6 } }]),
    },
    poolPrediction: { findMany: async ({ where }) => (own(where), []) },
    podiumPrediction: { findMany: async ({ where }) => (own(where), []), findUnique: async () => null },
    competition: {
      findMany: async ({ where }) => {
        assert.deepEqual(where.id.in.sort(), [5, 6]);
        return competitions;
      },
    },
    match: { findMany: async ({ where }) => matches[where.competitionId] || [] },
    pool: { findMany: async () => [] },
    matchRound: { findMany: async () => [] },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  delete require.cache[require.resolve('../src/routes/personalRoutes')];
  const app = require('express')();
  app.use('/me', require('../src/routes/personalRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (token) =>
    fetch(`http://127.0.0.1:${server.address().port}/me/predictions/all`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  assert.equal((await get()).status, 401);
  const res = await get(jwt.sign({ userId: 7, sv: 0 }, process.env.JWT_SECRET));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.events.map((e) => [
      e.tournament.name,
      e.competition.name,
      e.tournament.archived,
      e.saved,
      e.toComplete,
      e.points,
    ]),
    [
      ['Challenge de Paris', 'Fleuret hommes', false, 1, 1, 0],
      ['Coupe de Lyon', 'Sabre dames', true, 1, 0, 5],
    ],
  );
  // Seules les lignes pronostiquées sont renvoyées (le podium non rempli et le match vide sont exclus).
  assert.deepEqual(
    body.events[0].rows.map((r) => r.key),
    ['match-1'],
  );
  assert.equal(body.events[1].rows[0].status, 'Terminé');
  assert.ok(seen.every((u) => u === 7));
});
