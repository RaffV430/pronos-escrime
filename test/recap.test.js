const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET ||= 'x'.repeat(40);
const { recapText } = require('../src/services/pushNotifications');

test('recap push wording', () => {
  assert.equal(
    recapText({ points: 42, rank: 3, players: 12 }),
    'Épreuve terminée · 42 points · 3e sur 12 · votre récap est prêt',
  );
  assert.equal(
    recapText({ points: 1, rank: 1, players: 5 }),
    'Épreuve terminée · 1 point · 1er sur 5 · votre récap est prêt',
  );
  assert.equal(recapText({ points: 0, rank: null, players: 0 }), 'Épreuve terminée · 0 point · votre récap est prêt');
});

test('GET /me/recap/:id: phases, best prediction, rank in the event, finished flag', async (t) => {
  const past = new Date(Date.now() - 3600e3);
  const competition = {
    id: 9,
    name: 'Fleuret hommes',
    tournamentId: 1,
    podiumFormat: 'INDIVIDUAL',
    podiumRoster: [],
    podiumResolvedAt: null,
    tournament: { name: 'CISM' },
  };
  const m = (id, round, p1, p2, s1, s2, pred, points) => ({
    id,
    competitionId: 9,
    round,
    player1: p1,
    player2: p2,
    startsAt: past,
    isFinished: true,
    score1: s1,
    score2: s2,
    winner: s1 > s2 ? 1 : 2,
    resultType: 'NORMAL',
    predictions: pred
      ? [{ userId: 7, predictedScore1: pred[0], predictedScore2: pred[1], pointsEarned: points, bonusPoints: 0 }]
      : [],
  });
  const matches = [
    m(1, 'T32', 'A', 'B', 15, 10, [15, 10], 5),
    m(2, 'T32', 'C', 'D', 8, 15, [15, 12], 0),
    m(3, 'T16', 'A', 'D', 15, 14, [15, 11], 2),
    m(4, 'T2', 'A', 'E', 15, 13, null, 0),
  ];
  const db = {
    user: { findUnique: async () => ({ sessionVersion: 0 }) },
    competition: { findUnique: async () => competition },
    match: {
      findMany: async ({ where }) => (where.competitionId === 9 ? matches : []),
      findFirst: async ({ where }) => matches.find((x) => x.round === where.round && x.isFinished) || null,
    },
    pool: {
      findMany: async () => [
        {
          id: 1,
          name: 'Poule 1',
          isFinal: true,
          lockMode: 'FIRST_RESULT',
          fencers: [
            {
              id: 11,
              name: 'A',
              position: 1,
              wins: 5,
              indicator: 12,
              predictions: [{ wins: 5, indicator: 12, pointsEarned: 8 }],
            },
          ],
        },
      ],
    },
    podiumPrediction: { findUnique: async () => null },
    matchRound: { findMany: async () => [] },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  require.cache[require.resolve('../src/services/standings')] = {
    exports: {
      standings: async (d, scope) => (
        assert.deepEqual(scope, { competitionId: 9 }),
        [
          { id: 3, rank: 1, totalPoints: 30 },
          { id: 7, rank: 2, totalPoints: 15 },
          { id: 8, rank: 3, totalPoints: 2 },
        ]
      ),
      invalidateStandings: () => {},
    },
  };
  delete require.cache[require.resolve('../src/routes/personalRoutes')];
  const app = require('express')();
  app.use('/me', require('../src/routes/personalRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    delete require.cache[require.resolve('../src/services/standings')];
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/me/recap/9`, {
    headers: { Authorization: `Bearer ${jwt.sign({ userId: 7, sv: 0 }, process.env.JWT_SECRET)}` },
  });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.finished, true);
  assert.equal(r.points, 15);
  assert.deepEqual([r.rank, r.players], [2, 3]);
  assert.deepEqual(
    r.phases.map((p) => [p.phase, p.points, p.count]),
    [
      ['Poules', 8, 1],
      ['T32', 5, 2],
      ['T16', 2, 1],
    ],
  );
  assert.deepEqual([r.exact, r.winners, r.played], [1, 2, 3]);
  assert.deepEqual([r.best.type, r.best.name, r.best.points], ['Poule', 'Poule 1 · A', 8]);
  assert.equal(r.tournamentName, 'CISM');
});
