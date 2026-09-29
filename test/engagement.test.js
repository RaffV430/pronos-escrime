const { test } = require('node:test');
const assert = require('node:assert/strict');
const { engagement, remind } = require('../src/services/engagement');

const future = new Date(Date.now() + 3600000);
const bout = (id, competitionId, extra = {}) => ({
  id,
  competitionId,
  player1: `A${id}`,
  player2: `B${id}`,
  round: 'T16',
  startsAt: future,
  isFinished: false,
  ...extra,
});
function db() {
  const audits = [];
  return {
    audits,
    tournament: {
      findUnique: async () => ({
        id: 9,
        name: 'Challenge',
        competitions: [
          { id: 5, name: 'Fleuret H' },
          { id: 6, name: 'Fleuret D' },
        ],
      }),
    },
    user: {
      findMany: async () => [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Chloé' },
        { id: 4, name: 'Denis' },
      ],
    },
    prediction: {
      findMany: async ({ where }) =>
        where.matchId
          ? [
              { userId: 1, matchId: 10 },
              { userId: 1, matchId: 11 },
              { userId: 2, matchId: 10 },
            ]
          : [
              { userId: 1, createdAt: new Date(), match: { competitionId: 5 } },
              { userId: 2, createdAt: new Date(), match: { competitionId: 5 } },
            ],
    },
    poolPrediction: {
      findMany: async () => [{ userId: 3, updatedAt: new Date(), fencer: { pool: { competitionId: 6 } } }],
    },
    podiumPrediction: { findMany: async () => [] },
    match: {
      findMany: async ({ where }) =>
        [bout(10, 5), bout(11, 5), bout(12, 5, { isFinished: true })].filter(
          (m) => !where.competitionId?.in || where.competitionId.in.includes(m.competitionId),
        ),
    },
    matchRound: {
      findMany: async () => [{ competitionId: 5, round: 'T16', expectedMatchCount: 8, verifiedAt: new Date() }],
    },
    competition: { findUnique: async () => ({ id: 5, name: 'Fleuret H', tournamentId: 9 }) },
    pushSubscription: {
      findMany: async () => [
        { id: 's1', userId: 1 },
        { id: 's2', userId: 2 },
        { id: 's4', userId: 4 },
      ],
    },
    auditLog: {
      findFirst: async () => audits.at(-1) || null,
      create: async ({ data }) => audits.push({ ...data, createdAt: new Date() }),
    },
  };
}

test('engagement: participation, players per event and players without any prediction', async () => {
  const out = await engagement(db(), 9);
  assert.equal(out.users, 4);
  assert.equal(out.activePlayers, 3);
  assert.equal(out.participation, 75);
  assert.deepEqual(
    out.competitions.map((c) => [c.name, c.players, c.predictions]),
    [
      ['Fleuret H', 2, 2],
      ['Fleuret D', 1, 0],
    ],
  );
  assert.deepEqual(
    out.inactive.map((u) => u.name),
    ['Denis'],
  );
});

test('reminder: only followers with open matches left to predict, at most every 30 min, logged', async () => {
  const d = db();
  const sent = [];
  const push = { configured: () => true, send: async (sub, content) => sent.push([sub.userId, content.body]) };
  const out = await remind(d, 5, 1, { push });
  // Alice a tout pronostiqué ; Bob manque 1 match ; Denis en manque 2.
  assert.deepEqual(sent, [
    [2, '1 match à pronostiquer : c’est le moment !'],
    [4, '2 matchs à pronostiquer : c’est le moment !'],
  ]);
  assert.deepEqual(out, { sent: 2, players: 2, openMatches: 2 });
  assert.equal(d.audits[0].action, 'Relance des joueurs');
  await assert.rejects(remind(d, 5, 1, { push }), /moins de 30 minutes/);
  await assert.rejects(remind(db(), 5, 1, { push: { configured: () => false } }), /non configurées/);
});
