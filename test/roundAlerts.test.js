const { test } = require('node:test'),
  assert = require('node:assert/strict');
const push = require('../src/services/pushNotifications');
const bout = (id, more = {}) => ({
  id,
  competitionId: 5,
  round: 'T8',
  player1: 'Alpha',
  player2: 'Beta',
  startsAt: new Date(Date.now() + 3600000),
  predictions: [],
  ...more,
});
test('half of real matches, rounded up, with no unknown, cancelled or closed bouts', () => {
  const r = { round: 'T8', expectedMatchCount: 3 };
  assert.equal(push.roundAlertPlan([bout(1)], r).threshold, false);
  assert.equal(push.roundAlertPlan([bout(1), bout(2)], r).threshold, true);
  for (const more of [{ player2: '' }, { resultType: 'CANCELLED' }, { isLocked: true }, { isFinished: true }])
    assert.equal(push.roundAlertPlan([bout(1), bout(2, more)], r).threshold, false);
  assert.equal(push.roundAlertPlan([bout(1)], { round: 'T8', expectedMatchCount: 0 }).threshold, false);
  const p = push.roundAlertPlan([bout(1, { predictions: [{}] }), bout(2)], r);
  assert.equal(p.threshold, true);
  assert.deepEqual(
    p.missing.map((m) => m.id),
    [2],
  );
});
test('ten-minute boundary and only outstanding predictions', () => {
  const now = Date.now(),
    r = { round: 'T8', expectedMatchCount: 4 };
  const rows = [
    bout(1, { startsAt: new Date(now + 600000) }),
    bout(2, { startsAt: new Date(now + 600001) }),
    bout(3, { startsAt: new Date(now + 100000), predictions: [{}] }),
    bout(4, { startsAt: new Date(now) }),
  ];
  assert.deepEqual(
    push.roundAlertPlan(rows, r, now).urgent.map((m) => m.id),
    [1],
  );
});
test('one threshold alert per round, reminder replaces coincident threshold, no repeated ticks', async () => {
  const sub = {
      id: 's',
      userId: 1,
      enabled: true,
      tournamentIds: [1],
      competitionIds: [],
      preferences: { newMatches: true, reminders: true },
    },
    rows = [bout(1)],
    deliveries = [];
  const db = {
    $queryRaw: async () => [],
    pushSubscription: { findUnique: async () => sub },
    competition: { findMany: async () => [{ id: 5, tournamentId: 1 }] },
    match: { findMany: async () => rows },
    matchRound: { findMany: async () => [{ competitionId: 5, round: 'T8', expectedMatchCount: 4 }] },
    pushDelivery: {
      upsert: async ({ create }) => {
        if (!deliveries.some((d) => d.kind === create.kind))
          deliveries.push({ ...create, status: create.status || 'PENDING' });
      },
      updateMany: async ({ where, data }) => {
        for (const d of deliveries) if (d.kind === where.kind && d.status === where.status) Object.assign(d, data);
      },
    },
  };
  db.$transaction = (f) => f(db);
  await push.queueSpecial(db, 's');
  assert.equal(deliveries.length, 0);
  rows.push(bout(2));
  await push.queueSpecial(db, 's');
  await push.queueSpecial(db, 's');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].kind, 'AVAILABLE');
  rows.forEach((m) => (m.startsAt = new Date(Date.now() + 599000)));
  await push.queueSpecial(db, 's');
  await push.queueSpecial(db, 's');
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].status, 'CANCELLED');
  assert.equal(deliveries[1].kind, 'REMINDER');
});
test('threshold send rechecks missing predictions and sends only outstanding match links', async () => {
  let sent,
    status,
    saved = [{ matchId: 1 }];
  const db = {
    matchRound: { findMany: async () => [{ round: 'T8', expectedMatchCount: 4 }] },
    prediction: { findMany: async () => saved },
    pushDelivery: { updateMany: async ({ data }) => (status = data.status) },
  };
  const d = { id: 'd', kind: 'AVAILABLE', round: 'T8', createdAt: new Date() },
    s = { enabled: true, userId: 1, preferences: {}, tournamentIds: [1], competitionIds: [] },
    c = { id: 5, tournamentId: 1, name: 'Test' };
  await push.deliverSpecial(db, d, s, c, [bout(1), bout(2)], async (_, p) => (sent = p));
  assert.equal(status, 'SENT');
  assert.equal(sent.title, 'Test');
  assert.match(sent.body, /T8 · 1 match à pronostiquer · clôture à/);
  assert.match(sent.url, /matches=2$/);
  saved.push({ matchId: 2 });
  await push.deliverSpecial(db, d, s, c, [bout(1), bout(2)], () => assert.fail('already saved'));
  assert.equal(status, 'CANCELLED');
});
