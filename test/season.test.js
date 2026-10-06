const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';
const { seasonOf, buildSeason } = require('../src/services/season');

test('seasons run from 1 September to 31 August', () => {
  assert.equal(seasonOf('2026-08-31T23:59:00Z'), 2025);
  assert.equal(seasonOf('2026-09-01T00:00:00Z'), 2026);
  assert.equal(seasonOf('2027-03-15T10:00:00Z'), 2026);
  assert.equal(seasonOf('not a date'), null);
});

// Deux tournois : un en novembre 2026 (saison 2026-2027), un en mai 2026 (saison 2025-2026).
const match = (id, competitionId, extra) => ({
  id,
  competitionId,
  player1: `A${id}`,
  player2: `B${id}`,
  round: 'T16',
  startsAt: '2026-11-14T09:00:00Z',
  ...extra,
});
function fixture() {
  return {
    tournaments: [
      {
        id: 1,
        name: 'Challenge de Paris',
        createdAt: '2026-10-01T00:00:00Z',
        archivedAt: null,
        competitions: [{ id: 10, name: 'Fleuret hommes' }],
      },
      {
        id: 2,
        name: 'Coupe de mai',
        createdAt: '2026-04-01T00:00:00Z',
        archivedAt: '2026-06-01T00:00:00Z',
        competitions: [{ id: 20, name: 'Fleuret dames' }],
      },
    ],
    firstDates: new Map([
      [10, '2026-11-14T09:00:00Z'],
      [20, '2026-05-10T09:00:00Z'],
    ]),
    predictions: [
      {
        id: 1,
        predictedScore1: 15,
        predictedScore2: 8,
        pointsEarned: 4,
        match: match(101, 10, { isFinished: true, score1: 15, score2: 8, winner: 1, resultType: 'NORMAL' }),
      },
      {
        id: 2,
        predictedScore1: 15,
        predictedScore2: 10,
        pointsEarned: 1,
        match: match(102, 10, { isFinished: true, score1: 15, score2: 12, winner: 1, resultType: 'NORMAL' }),
      },
      {
        id: 3,
        predictedScore1: 8,
        predictedScore2: 15,
        pointsEarned: 0,
        match: match(103, 10, { isFinished: true, score1: 15, score2: 3, winner: 1, resultType: 'NORMAL' }),
      },
      {
        id: 4,
        predictedScore1: 15,
        predictedScore2: 14,
        pointsEarned: 0,
        match: match(104, 10, { isFinished: false }),
      },
      {
        id: 5,
        predictedScore1: 15,
        predictedScore2: 9,
        pointsEarned: 0,
        match: match(105, 10, { isFinished: false, resultType: 'CANCELLED' }),
      },
      {
        id: 6,
        predictedScore1: 5,
        predictedScore2: 15,
        pointsEarned: 1,
        match: match(106, 10, {
          isFinished: true,
          score1: null,
          score2: null,
          winner: 2,
          resultType: 'MEDICAL_WITHDRAWAL',
        }),
      },
      {
        id: 7,
        predictedScore1: 15,
        predictedScore2: 2,
        pointsEarned: 4,
        match: match(201, 20, {
          startsAt: '2026-05-10T09:00:00Z',
          isFinished: true,
          score1: 15,
          score2: 2,
          winner: 1,
          resultType: 'NORMAL',
        }),
      },
    ],
    poolPredictions: [
      {
        id: 1,
        wins: 4,
        indicator: 10,
        pointsEarned: 8,
        fencer: {
          name: 'Martin',
          wins: 4,
          indicator: 10,
          pool: { name: 'Poule 1', competitionId: 10, isFinal: true, closesAt: '2026-11-14T08:00:00Z' },
        },
      },
      {
        id: 2,
        wins: 2,
        indicator: 0,
        pointsEarned: 0,
        fencer: {
          name: 'Petit',
          wins: null,
          indicator: null,
          pool: { name: 'Poule 2', competitionId: 10, isFinal: false, closesAt: '2026-11-14T08:00:00Z' },
        },
      },
    ],
    podiums: [
      {
        id: 1,
        competitionId: 10,
        gold: 'A',
        silver: 'B',
        bronze1: 'C',
        bronze2: 'D',
        pointsEarned: 20,
        competition: { podiumFormat: 'INDIVIDUAL', podiumResolvedAt: '2026-11-15T00:00:00Z' },
      },
    ],
    challengePicks: [{ id: 1, winner: 1, challenge: { name: 'Choc', matchId: 102, bonus: 3 } }],
    challengeMatches: [match(102, 10, { isFinished: true, score1: 15, score2: 12, winner: 1, resultType: 'NORMAL' })],
    adjustments: [
      {
        id: 1,
        points: 2,
        reason: 'Geste commercial',
        tournamentId: 1,
        competitionId: null,
        createdAt: '2026-11-20T00:00:00Z',
      },
      { id: 2, points: -1, reason: null, tournamentId: null, competitionId: 20, createdAt: '2026-05-11T00:00:00Z' },
    ],
  };
}

test('a season gathers every prediction with its points, outcomes and totals', () => {
  const out = buildSeason(fixture(), 2026, new Date('2026-12-01T00:00:00Z'));
  assert.equal(out.label, '2026-2027');
  assert.deepEqual(
    out.seasons.map((s) => s.season),
    [2026, 2025],
  );
  assert.deepEqual(
    out.tournaments.map((t) => t.name),
    ['Challenge de Paris'],
  );
  const rows = out.tournaments[0].competitions[0].rows;
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey['match-1'].outcome, 'exact');
  assert.deepEqual(byKey['match-1'].details, ['Bon vainqueur : +1', 'Score exact : +3']);
  assert.equal(byKey['match-2'].outcome, 'points');
  assert.equal(byKey['match-3'].outcome, 'miss');
  assert.equal(byKey['match-4'].outcome, 'pending');
  assert.equal(byKey['match-4'].points, null);
  assert.equal(byKey['match-5'].outcome, 'cancelled');
  assert.equal(byKey['match-6'].outcome, 'points');
  assert.match(byKey['match-6'].result, /Retrait médical · B106/);
  assert.equal(byKey['pool-1'].outcome, 'exact');
  assert.equal(byKey['pool-2'].outcome, 'pending');
  assert.equal(byKey['podium-1'].points, 20);
  assert.equal(byKey['challenge-1'].points, 3);
  assert.deepEqual(out.totals, { match: 6, outsider: 0, pool: 8, podium: 20, challenge: 3, adjustment: 2, total: 39 });
  assert.equal(out.tournaments[0].points, 37, 'tournament points exclude adjustments listed separately');
  assert.deepEqual(out.stats, { predictions: 9, pending: 2, matchesPlayed: 4, exact: 1, winners: 3, accuracy: 75 });
});

test('previous seasons stay available and unknown seasons fall back to the current one', () => {
  const previous = buildSeason(fixture(), 2025, new Date('2026-12-01T00:00:00Z'));
  assert.equal(previous.label, '2025-2026');
  assert.deepEqual(
    previous.tournaments.map((t) => [t.name, t.archived]),
    [['Coupe de mai', true]],
  );
  assert.deepEqual(previous.totals, {
    match: 4,
    outsider: 0,
    pool: 0,
    podium: 0,
    challenge: 0,
    adjustment: -1,
    total: 3,
  });
  assert.equal(buildSeason(fixture(), 1999, new Date('2026-12-01T00:00:00Z')).season, 2026);
  const empty = buildSeason(
    { ...fixture(), predictions: [], poolPredictions: [], podiums: [], challengePicks: [], adjustments: [] },
    null,
    new Date('2027-10-01T00:00:00Z'),
  );
  assert.equal(empty.label, '2027-2028');
  assert.deepEqual(empty.tournaments, []);
  assert.equal(empty.stats.accuracy, null);
});

test('GET /api/me/season only reads the signed-in player and validates the season', async (t) => {
  const f = fixture();
  const own = (where) => assert.equal(where.userId, 7, 'only the signed-in player is read');
  const groupBy =
    (field) =>
    async ({ where }) =>
      where.competitionId.in.map((id) => ({ competitionId: id, _min: { [field]: f.firstDates.get(id) } }));
  const db = {
    user: { findUnique: async () => ({ sessionVersion: 0 }) },
    prediction: {
      findMany: async ({ where, select }) => {
        if (where.userId !== undefined) return (own(where), f.predictions);
        // Trophées : lecture des points de tous, jamais des scores pronostiqués.
        assert.deepEqual(Object.keys(select).sort(), ['bonusPoints', 'matchId', 'pointsEarned', 'userId']);
        return [];
      },
    },
    poolPrediction: { findMany: async ({ where }) => (own(where), f.poolPredictions) },
    podiumPrediction: { findMany: async ({ where }) => (own(where), f.podiums) },
    challengePick: { findMany: async ({ where }) => (own(where), f.challengePicks) },
    pointAdjustment: { findMany: async ({ where }) => (own(where), f.adjustments) },
    match: { findMany: async () => f.challengeMatches, groupBy: groupBy('startsAt') },
    pool: { groupBy: groupBy('closesAt') },
    tournament: { findMany: async () => f.tournaments },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const express = require('express');
  const app = express();
  app.use('/me', require('../src/routes/personalRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (q, token = jwt.sign({ userId: 7, sv: 0 }, process.env.JWT_SECRET)) =>
    fetch(`http://127.0.0.1:${server.address().port}/me/season${q}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  assert.equal((await get('', null)).status, 401);
  assert.equal((await get('?season=abc')).status, 400);
  const res = await get('?season=2025');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.label, '2025-2026');
  assert.equal(body.totals.total, 3);
});

test('an event lists pools first, then bouts by time, and the podium last', () => {
  const out = buildSeason(fixture(), 2026, new Date('2026-12-01T00:00:00Z'));
  const types = out.tournaments[0].competitions[0].rows.map((r) => r.type);
  assert.deepEqual(types.slice(0, 2), ['Poule', 'Poule']);
  assert.equal(types.at(-1), 'Podium');
});

test('podium row: perfect only when every medal is exact (60 individual, 45 team)', () => {
  const f = fixture();
  const out = (points, format) =>
    buildSeason(
      {
        ...f,
        podiums: [
          {
            ...f.podiums[0],
            pointsEarned: points,
            competition: { podiumFormat: format, podiumResolvedAt: '2026-11-15T00:00:00Z' },
          },
        ],
      },
      2026,
      new Date('2026-12-01T00:00:00Z'),
    ).tournaments[0].competitions[0].rows.find((r) => r.type === 'Podium');
  assert.equal(out(60, 'INDIVIDUAL').perfect, true);
  assert.equal(out(60, 'INDIVIDUAL').outcome, 'exact');
  assert.equal(out(50, 'INDIVIDUAL').perfect, false);
  assert.equal(out(45, 'TEAM').perfect, true);
  assert.equal(out(40, 'TEAM').perfect, false);
});

test('personal analysis: success by round, average score gap, pools, outsider hits and best event', () => {
  const out = buildSeason(fixture(), 2026, new Date('2026-12-01T00:00:00Z'));
  const a = out.analysis;
  // T16 : 3 matchs normaux terminés + 1 retrait médical.
  assert.deepEqual(a.byRound, [{ round: 'T16', played: 4, winners: 3, exact: 1, points: 6, accuracy: 75 }]);
  // Écarts : 0 (15-8 exact), 2 (15-10 vs 15-12), 19 (8-15 vs 15-3) → moyenne 7 ; le retrait médical ne compte pas.
  assert.equal(a.averageScoreGap, 7);
  assert.equal(a.bestRound, 'T16');
  assert.equal(a.outsiderHits, 0);
  assert.deepEqual(a.pools, { predicted: 1, winsExact: 1, winsAccuracy: 100, averageIndicatorGap: 0 });
  assert.equal(a.bestCompetition.name, 'Fleuret hommes');
  assert.equal(a.bestCompetition.points, 37);
  // Meilleur coup : le score exact 15-8 ; série de bons vainqueurs dans l'ordre des matchs.
  assert.equal(a.bestCall.exact, true);
  assert.equal(a.bestCall.result, '15 – 8');
  assert.ok(a.bestCall.points >= 3);
  assert.ok(a.longestStreak >= 1 && a.longestStreak <= 3);
});
