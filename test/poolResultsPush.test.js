const test = require('node:test');
const assert = require('node:assert/strict');
const push = require('../src/services/pushNotifications');
const { preferences } = require('../src/services/playerExperience');

test('pool results option: off by default, validated like the others', () => {
  assert.equal(preferences({}).poolResults, false);
  assert.equal(preferences({ poolResults: true }).poolResults, true);
  assert.throws(() => preferences({ poolResults: 'yes' }), /invalide/);
});

test('pools finished only when every pool is published; message wording', () => {
  const at = (h) => new Date(`2026-09-29T0${h}:00:00Z`);
  assert.equal(push.poolsFinishedAt([]), null);
  assert.equal(
    push.poolsFinishedAt([
      { isFinal: true, fencers: [] },
      { isFinal: false, fencers: [] },
    ]),
    null,
  );
  assert.equal(
    push.poolsFinishedAt([
      { isFinal: true, fencers: [{ firstResultAt: at(6) }] },
      { isFinal: true, fencers: [{ firstResultAt: at(8) }, { firstResultAt: null }] },
    ]),
    at(8).getTime(),
  );
  assert.equal(push.poolResultsText(23, 7), 'Poules terminées · 23 points (7 tireurs pronostiqués)');
  assert.equal(push.poolResultsText(1, 1), 'Poules terminées · 1 point (1 tireur pronostiqué)');
});

function setup({ prefs, played = 3, since = new Date(Date.now() - 3600e3), finished = new Date(Date.now() - 60e3) }) {
  const upserts = [];
  const sub = {
    id: 's1',
    userId: 7,
    enabled: true,
    tournamentIds: [1],
    competitionIds: [],
    preferences: prefs,
    preferencesSince: since,
    createdAt: since,
  };
  const tx = {
    $queryRaw: async () => [],
    pushSubscription: { findUnique: async () => sub },
    poolPrediction: { count: async ({ where }) => (assert.equal(where.userId, 7), played) },
    pushDelivery: { upsert: async (q) => (upserts.push(q.create), q.create), updateMany: async () => ({}) },
    prediction: { findMany: async () => [] },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  const context = [
    {
      competition: { id: 9, tournamentId: 1, name: 'Fleuret' },
      matches: [],
      rounds: [],
      pools: [{ isFinal: true, fencers: [{ firstResultAt: finished }] }],
    },
  ];
  return { db, context, upserts };
}

test('queued once per event, only when opted in, played, and finished after opting in', async () => {
  const on = { newMatches: false, reminders: false, roundResults: false, poolResults: true };
  let s = setup({ prefs: on });
  await push.queueSpecial(s.db, 's1', s.context);
  assert.deepEqual(
    s.upserts.map((u) => [u.kind, u.round, u.competitionId]),
    [['POOLRESULTS', 'pools', 9]],
  );
  s = setup({ prefs: { ...on, poolResults: false, newMatches: true } });
  await push.queueSpecial(s.db, 's1', s.context);
  assert.equal(s.upserts.length, 0, 'option off by default');
  s = setup({ prefs: on, played: 0 });
  await push.queueSpecial(s.db, 's1', s.context);
  assert.equal(s.upserts.length, 0, 'no pool prediction in this event');
  s = setup({ prefs: on, since: new Date(), finished: new Date(Date.now() - 3600e3) });
  await push.queueSpecial(s.db, 's1', s.context);
  assert.equal(s.upserts.length, 0, 'pools finished before the option was turned on');
});

test('delivery: points of the published pools, link to Mes pronostics; cancelled if the option was turned off', async () => {
  const sent = [];
  const updates = [];
  const db = {
    poolPrediction: { findMany: async () => [{ pointsEarned: 8 }, { pointsEarned: 3 }, { pointsEarned: 0 }] },
    pushDelivery: { updateMany: async (q) => (updates.push(q.data.status), {}) },
  };
  const sub = {
    id: 's1',
    userId: 7,
    enabled: true,
    tournamentIds: [1],
    competitionIds: [],
    preferences: { poolResults: true },
  };
  const c = { id: 9, tournamentId: 1, name: 'Fleuret hommes' };
  const delivery = { id: 'd1', kind: 'POOLRESULTS', round: 'pools', createdAt: new Date(), attempts: 0 };
  await push.deliverSpecial(
    db,
    delivery,
    sub,
    c,
    [],
    async (s, content, ttl, urgency) => (assert.equal(urgency, 'normal'), sent.push(content)),
  );
  assert.equal(sent[0].body, 'Poules terminées · 11 points (3 tireurs pronostiqués)');
  assert.equal(sent[0].url, '/?tournament=1&event=9&view=mine');
  assert.deepEqual(updates, ['SENT']);
  await push.deliverSpecial(db, delivery, { ...sub, preferences: {} }, c, [], async (s, content) => sent.push(content));
  assert.equal(sent.length, 1);
  assert.deepEqual(updates, ['SENT', 'CANCELLED']);
});
