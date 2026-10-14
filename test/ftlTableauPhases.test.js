const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preliminary, combine } = require('../src/services/ftlTableauPhases');
const { planMatches, applyObservation } = require('../src/services/ftlSync');
const { roundContext, podiumClosed } = require('../src/lib/matchLock');
const round = (round, previousRound, n) => ({ round, previousRound, expectedMatchCount: n });
const match = {
  round: 'T64',
  sourceKey: 'Table of 64:1',
  player1: 'TEST A',
  player2: 'TEST B',
  isFinished: true,
  score1: 15,
  score2: 10,
  winner: 1,
};
const prelim = () =>
  preliminary({
    sourceUrl: 'j1',
    rounds: [round('T128', null, 64), round('T64', 'T128', 32)],
    matches: [{ ...match }],
    byes: [],
    issues: [],
    warnings: [],
  });
test('deux T64 ont des clés distinctes ; seul le tableau principal peut fournir le podium', () => {
  const old = prelim();
  const main = {
    sourceUrl: 'j2',
    rounds: [
      round('T64', null, 32),
      round('T32', 'T64', 16),
      round('T16', 'T32', 8),
      round('T8', 'T16', 4),
      round('T4', 'T8', 2),
      round('T2', 'T4', 1),
    ],
    matches: [{ ...match, isFinished: false, score1: null, score2: null }],
    officialPodium: { gold: 'a' },
    warnings: [],
  };
  const all = combine([old, main]);
  assert.deepEqual(
    all.matches.map((m) => [m.round, m.sourceKey, m.sourceUrl]),
    [
      ['J1:T64', 'J1:Table of 64:1', 'j1'],
      ['T64', 'Table of 64:1', 'j2'],
    ],
  );
  assert.equal(all.officialPodium, main.officialPodium);
  const existing = { ...old.matches[0], id: 7, competitionId: 1 };
  const predictions = [{ id: 4, matchId: 7, pointsEarned: 4, predictedScore1: 15, predictedScore2: 10 }];
  const before = structuredClone([existing, predictions]);
  const plan = planMatches([existing], all, { allowPartial: true });
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan[0].current.id, 7);
  assert.equal(plan[1].current, undefined);
  assert.deepEqual([existing, predictions], before);
});
test('un ancien match du J1 conserve son identifiant lors de sa distinction de phase', () => {
  const old = { ...match, id: 7, competitionId: 1, sourceUrl: 'j1' };
  const plan = planMatches([old], combine([prelim()]), { allowPartial: true });
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan[0].current.id, 7);
  const main = {
    sourceUrl: 'j2',
    rounds: [round('T2', null, 1)],
    matches: [{ ...match, player2: 'TEST C', isFinished: false }],
    warnings: [],
  };
  const both = planMatches([old], combine([prelim(), main]), { allowPartial: true });
  assert.equal(both.conflicts.length, 0);
  assert.equal(both[0].current.id, 7);
  assert.equal(both[1].current, undefined);
});
test('la fin du J1 ne ferme ni le T64 principal du J2 ni le podium', () => {
  const start = new Date('2026-10-17T00:00:00Z');
  const rounds = [
    { competitionId: 1, ...round('J1:T64', null, 32) },
    { competitionId: 1, ...round('T64', null, 32) },
  ];
  const matches = [
    { ...match, id: 7, competitionId: 1, round: 'J1:T64', resultRegisteredAt: new Date('2026-10-15T03:00:00Z') },
    { id: 8, competitionId: 1, round: 'T64', startsAt: start, isFinished: false },
  ];
  const timed = roundContext(matches, rounds);
  assert.equal(timed[1].previousRoundCompletedAt, null);
  assert.equal(podiumClosed({}, timed, Date.parse('2026-10-16T00:00:00Z')), false);
});

test('une victoire du T64 préliminaire annonce le J2, pas un T32 du J1', () => {
  const { fencerResultText } = require('../src/services/notificationText');
  const result = fencerResultText({ name: 'TEST' }, { ...match, round: 'J1:T64' }, ['TEST A']);
  assert.match(result.body, /tableau principal du J2/);
  assert.doesNotMatch(result.body, /T32/);
});
