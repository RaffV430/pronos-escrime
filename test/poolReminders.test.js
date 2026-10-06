const test = require('node:test');
const assert = require('node:assert/strict');
const push = require('../src/services/pushNotifications');
const R = require('../src/services/poolReminders');

const now = Date.parse('2026-10-10T07:52:00Z');
const at = (min) => new Date(now + min * 60000).toISOString();
const pool = (id, name, extra = {}) => ({
  id,
  name,
  isFinal: false,
  isLocked: false,
  lockMode: 'START',
  closesAt: at(8),
  startsAt: at(8),
  fencers: [{ firstResultAt: null }],
  ...extra,
});

test('rappel des poules : seulement les poules sans pronostic qui ferment dans les 10 minutes, par tour', () => {
  const pools = [
    pool(1, 'Poule 1'),
    pool(2, 'Poule 2'),
    pool(3, 'Poule 3', { closesAt: at(25) }), // trop tôt
    pool(4, 'Poule 4', { isLocked: true }),
    pool(5, 'Poule 5', { lockMode: 'FIRST_RESULT', closesAt: at(-60), startsAt: at(5) }), // ferme au début
    pool(6, 'Poule 6', { fencers: [{ firstResultAt: at(-1) }] }), // déjà commencée
    pool(7, 'Poule 7', { lockMode: 'PROVISIONAL' }),
    pool(8, 'Tour 2 · Poule 1', { closesAt: at(3) }),
  ];
  const plan = R.reminderPlan(pools, [2], now);
  assert.deepEqual(
    plan.map((p) => [p.key, p.missing.map((x) => x.id)]),
    [
      ['pools-reminder-1', [1, 5]],
      ['pools-reminder-2', [8]],
    ],
  );
  const text = R.reminderText({ id: 9, tournamentId: 2, name: 'Fleuret' }, plan[0].missing, 'Europe/Paris');
  assert.equal(text.body, 'Poules · 2 poules sans pronostic · clôture vers 09:57');
  assert.equal(text.url, '/?tournament=2&event=9&view=pools');
});

test('file : une seule notification par tour, et rien si la préférence « Rappels » est coupée', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const run = async (prefs, predicted = []) => {
    const upserts = [];
    const sub = {
      id: 's1',
      userId: 7,
      enabled: true,
      tournamentIds: [2],
      competitionIds: [],
      preferences: prefs,
      createdAt: new Date(now - 86400000),
    };
    const tx = {
      $queryRaw: async () => [],
      pushSubscription: { findUnique: async () => sub },
      poolPrediction: {
        findMany: async () => predicted.map((poolId) => ({ fencer: { poolId } })),
        count: async () => 0,
      },
      pushDelivery: { upsert: async (q) => (upserts.push(q.create), q.create), updateMany: async () => ({}) },
      prediction: { findMany: async () => [] },
    };
    const context = [
      {
        competition: { id: 9, tournamentId: 2, name: 'Fleuret' },
        matches: [],
        rounds: [],
        pools: [pool(1, 'Poule 1'), pool(2, 'Poule 2')],
      },
    ];
    await push.queueSpecial({ $transaction: async (fn) => fn(tx) }, 's1', context);
    return upserts.filter((u) => u.kind === 'POOLREMINDER');
  };
  const queued = await run({
    reminders: true,
    newMatches: false,
    roundResults: false,
    poolResults: false,
    quietEnabled: false,
  });
  assert.deepEqual(
    queued.map((u) => [u.round, u.matchIds]),
    [['pools-reminder-1', [1, 2]]],
  );
  assert.equal((await run({ reminders: true, newMatches: false, quietEnabled: false }, [1, 2])).length, 0);
  assert.equal((await run({ reminders: false, newMatches: true, quietEnabled: false })).length, 0);
});

test('envoi : revérifié (pronostic fait entre-temps = annulé)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const sent = [];
  const updates = [];
  const mk = (predicted) => ({
    pool: { findMany: async () => [pool(1, 'Poule 1'), pool(2, 'Poule 2')] },
    poolPrediction: { findMany: async () => predicted.map((poolId) => ({ fencer: { poolId } })) },
    pushDelivery: { updateMany: async (q) => (updates.push(q.data.status), {}) },
  });
  const sub = {
    id: 's1',
    userId: 7,
    enabled: true,
    tournamentIds: [2],
    competitionIds: [],
    preferences: { reminders: true },
  };
  const c = { id: 9, tournamentId: 2, name: 'Fleuret' };
  const delivery = {
    id: 'd1',
    kind: 'POOLREMINDER',
    round: 'pools-reminder-1',
    matchIds: [1, 2],
    createdAt: new Date(now),
    attempts: 0,
  };
  await push.deliverSpecial(mk([2]), delivery, sub, c, [], async (s, content, ttl, urgency) => {
    assert.equal(urgency, 'high');
    assert.ok(ttl > 0 && ttl <= 480);
    sent.push(content);
  });
  assert.equal(sent[0].body.startsWith('Poules · 1 poule sans pronostic'), true);
  await push.deliverSpecial(mk([1, 2]), delivery, sub, c, [], async (s, content) => sent.push(content));
  assert.equal(sent.length, 1);
  assert.deepEqual(updates, ['SENT', 'CANCELLED']);
});
