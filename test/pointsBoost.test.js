const test = require('node:test');
const assert = require('node:assert/strict');
const boost = require('../src/services/pointsBoost');
const { funTags, scoreGap } = require('../src/services/funFilters');
const { challengePoints } = require('../src/services/communityRules');
const { applyOutsiderBonus } = require('../src/services/outsider');

const HOUR = 3600000;

test('a boost covers only its scope', () => {
  const c = (scope, round = null) => ({ pointsBoosts: [{ key: boost.keyOf(scope, round), scope, round }] });
  assert.equal(boost.multiplierFor(c('EVENT'), 'POOL'), 2);
  assert.equal(boost.multiplierFor(c('EVENT'), 'PODIUM'), 2);
  assert.equal(boost.multiplierFor(c('POOLS'), 'POOL'), 2);
  assert.equal(boost.multiplierFor(c('POOLS'), 'MATCH', 'T16'), 1);
  assert.equal(boost.multiplierFor(c('TABLEAU'), 'MATCH', 'T64'), 2);
  assert.equal(boost.multiplierFor(c('TABLEAU'), 'PODIUM'), 1);
  assert.equal(boost.multiplierFor(c('ROUND', 'T8'), 'MATCH', 'T8'), 2);
  assert.equal(boost.multiplierFor(c('ROUND', 'T8'), 'MATCH', 'T16'), 1);
  assert.equal(boost.multiplierFor(c('PODIUM'), 'PODIUM'), 2);
  assert.equal(boost.multiplierFor({}, 'MATCH', 'T8'), 1);
  assert.equal(boost.multiplierFor({ pointsBoosts: [{ scope: 'NOPE' }] }, 'MATCH'), 1);
});

function fakeDb(state) {
  const tx = {
    $queryRaw: async () => [],
    competition: {
      findUnique: async () => ({ ...state.competition }),
      update: async ({ data }) => Object.assign(state.competition, data),
    },
    match: {
      findMany: async () => state.matches.map((m) => ({ ...m })),
      update: async ({ where, data }) =>
        Object.assign(
          state.matches.find((m) => m.id === where.id),
          data,
        ),
    },
    matchRound: { findMany: async () => state.rounds },
    pool: {
      findMany: async () => state.pools.map((p) => ({ ...p })),
      update: async ({ where, data }) =>
        Object.assign(
          state.pools.find((p) => p.id === where.id),
          data,
        ),
    },
    auditLog: { create: async ({ data }) => state.logs.push(data) },
    pushSubscription: { findMany: async () => state.subs },
    pushDelivery: {
      createMany: async ({ data }) => {
        state.deliveries.push(...data);
        return { count: data.length };
      },
    },
    tournament: { findUnique: async () => ({ name: 'Étampes' }) },
  };
  return { ...tx, $transaction: async (fn) => fn(tx) };
}

function state() {
  const later = new Date(Date.now() + 2 * HOUR).toISOString();
  return {
    logs: [],
    deliveries: [],
    subs: [
      { id: 's1', tournamentIds: [], competitionIds: [3], preferences: { followAll: false } },
      { id: 's2', tournamentIds: [], competitionIds: [99], preferences: { followAll: false } },
    ],
    competition: { id: 3, tournamentId: 1, name: 'Fleuret dames', podiumMultiplier: 1, pointsBoosts: null },
    rounds: [
      { competitionId: 3, round: 'T16', previousRound: null, expectedMatchCount: 1 },
      { competitionId: 3, round: 'T8', previousRound: 'T16', expectedMatchCount: 1 },
    ],
    matches: [
      // Tour déjà joué : reste à ×1.
      {
        id: 1,
        competitionId: 3,
        round: 'T16',
        isFinished: true,
        isLocked: true,
        resultRegisteredAt: new Date().toISOString(),
        pointsMultiplier: 1,
      },
      // Tour encore ouvert : passe à ×2.
      { id: 2, competitionId: 3, round: 'T8', isFinished: false, startsAt: later, pointsMultiplier: 1 },
    ],
    pools: [
      { id: 10, isLocked: false, isFinal: false, lockMode: 'FIRST_RESULT', fencers: [{}], pointsMultiplier: 1 },
      { id: 11, isLocked: true, isFinal: false, lockMode: 'FIRST_RESULT', fencers: [{}], pointsMultiplier: 1 },
    ],
  };
}

test('activating ×2 on the whole event only doubles what is still open and notifies followers', async () => {
  const s = state();
  const out = await boost.activate(fakeDb(s), 3, { scope: 'EVENT' }, 7);
  assert.deepEqual(
    s.matches.map((m) => m.pointsMultiplier),
    [1, 2],
  );
  assert.deepEqual(
    s.pools.map((p) => p.pointsMultiplier),
    [2, 1],
  );
  // Le podium est déjà clos (premier tour du tableau commencé).
  assert.equal(s.competition.podiumMultiplier, 1);
  assert.equal(out.notified, 1);
  assert.equal(s.deliveries[0].subscriptionId, 's1');
  assert.equal(s.deliveries[0].kind, 'BOOST');
  assert.equal(s.logs[0].action, 'Points ×2 activés');
  await assert.rejects(boost.activate(fakeDb(s), 3, { scope: 'EVENT' }, 7), /déjà actif/);
});

test('a round boost only stamps that round, and removing it restores open items', async () => {
  const s = state();
  s.matches[1].round = 'T8';
  await boost.activate(fakeDb(s), 3, { scope: 'ROUND', round: 'T8' }, 7);
  assert.deepEqual(
    s.matches.map((m) => m.pointsMultiplier),
    [1, 2],
  );
  assert.deepEqual(
    s.pools.map((p) => p.pointsMultiplier),
    [1, 1],
  );
  await assert.rejects(boost.activate(fakeDb(s), 3, { scope: 'ROUND', round: 'X' }, 7), /tour du tableau/);
  await boost.deactivate(fakeDb(s), 3, 'ROUND:T8', 7);
  assert.equal(s.matches[1].pointsMultiplier, 1);
  assert.equal(s.competition.pointsBoosts, null);
  await assert.rejects(boost.deactivate(fakeDb(s), 3, 'ROUND:T8', 7), /plus actif/);
});

test('the notification text follows the scope and is dropped once the boost is removed', async () => {
  const s = state();
  await boost.activate(fakeDb(s), 3, { scope: 'ROUND', round: 'T8' }, 7);
  const round = s.deliveries[0].round;
  const text = await boost.boostNotification(fakeDb(s), s.competition, round);
  assert.match(text.body, /^VITE ! Les points sont doublés sur ce tour \(quarts de finale\) de Fleuret dames/);
  const s2 = state();
  await boost.activate(fakeDb(s2), 3, { scope: 'EVENT' }, 7);
  const event = await boost.boostNotification(fakeDb(s2), s2.competition, s2.deliveries[0].round);
  assert.match(event.body, /^Profite !! Points doublés sur Fleuret dames/);
  await boost.deactivate(fakeDb(s), 3, 'ROUND:T8', 7);
  assert.equal(await boost.boostNotification(fakeDb(s), s.competition, round), null);
});

test('public boosts never expose the administrator', () => {
  const [b] = boost.publicBoosts({
    pointsBoosts: [{ key: 'EVENT', scope: 'EVENT', activatedAt: 'x', actorId: 7, tournament: true }],
  });
  assert.deepEqual(b, { key: 'EVENT', scope: 'EVENT', round: null, activatedAt: 'x', tournament: true });
});

test('doubled matches double the outsider bonus and the challenge bonus', async () => {
  const predictions = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    predictedScore1: i === 0 ? 15 : 5,
    predictedScore2: i === 0 ? 5 : 15,
    bonusPoints: 0,
  }));
  const writes = [];
  await applyOutsiderBonus({ updateMany: async (q) => writes.push(q) || { count: 1 } }, 1, predictions, 1, 'NORMAL', 2);
  assert.ok(writes.some((w) => w.data.bonusPoints === 2));
  const match = { isFinished: true, score1: 15, score2: 10, pointsMultiplier: 2 };
  assert.equal(challengePoints({ winner: 1 }, match, 3), 6);
  assert.equal(challengePoints({ winner: 1 }, { ...match, pointsMultiplier: 1 }, 3), 3);
});

test('fun filters tag near misses, reversed scores, upsets and one-touch wins', () => {
  const m = { isFinished: true, score1: 15, score2: 14, seed1: 20, seed2: 3, winner: 1 };
  const p = (a, b) => ({ predictedScore1: a, predictedScore2: b });
  assert.deepEqual(funTags(p(15, 14), m), ['exact', 'poker', 'wire']);
  assert.deepEqual(funTags(p(14, 13), m), ['near', 'poker', 'wire']);
  assert.deepEqual(funTags(p(14, 15), m), ['near', 'oops']);
  assert.deepEqual(funTags(p(14, 15), { ...m, score1: 15, score2: 14 }), ['near', 'oops']);
  assert.deepEqual(funTags(p(10, 15), { ...m, score1: 15, score2: 10 }), ['oops']);
  assert.deepEqual(funTags(p(15, 5), { ...m, seed1: 1 }), ['wire']);
  assert.deepEqual(funTags(p(15, 14), { ...m, resultType: 'MEDICAL_WITHDRAWAL' }), []);
  assert.deepEqual(funTags(p(15, 14), { ...m, isFinished: false }), []);
  assert.equal(scoreGap(p(5, 15), m), 11);
  assert.equal(scoreGap(p(5, 15), { ...m, resultType: 'CANCELLED' }), null);
});
