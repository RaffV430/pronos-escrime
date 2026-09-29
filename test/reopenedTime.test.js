const test = require('node:test');
const assert = require('node:assert/strict');
const { reopenedByPublishedTime } = require('../src/services/ftlSync');
const push = require('../src/services/pushNotifications');

const now = Date.parse('2026-09-29T12:30:00Z');
const semisDone = '2026-09-29T11:30:35Z'; // clôture par défaut à 11:40:35
const final = {
  id: 262,
  round: 'T2',
  startsAt: null,
  isFinished: false,
  isLocked: false,
  previousRoundCompletedAt: semisDone,
};
const at = (iso) => new Date(iso);

test('a final closed for lack of time is reported when FTL publishes a future time', () => {
  const late = [{ current: final, observed: { startsAt: at('2026-09-29T15:00:00Z') } }];
  assert.deepEqual(
    reopenedByPublishedTime(late, [final], now).map(({ m }) => m.id),
    [262],
  );
});

test('nothing reported: time already passed or too close, match finished, still open, locked, previous round pending', () => {
  const run = (current, startsAt, timed = [current]) =>
    reopenedByPublishedTime([{ current, observed: { startsAt: at(startsAt) } }], timed, now).length;
  assert.equal(run(final, '2026-09-29T12:20:00Z'), 0, 'time already passed');
  assert.equal(run(final, '2026-09-29T12:33:00Z'), 0, 'less than 5 minutes left');
  assert.equal(run({ ...final, isFinished: true }, '2026-09-29T15:00:00Z'), 0);
  assert.equal(
    run({ ...final, previousRoundCompletedAt: '2026-09-29T12:25:00Z' }, '2026-09-29T15:00:00Z'),
    0,
    'still open',
  );
  assert.equal(run({ ...final, isLocked: true }, '2026-09-29T15:00:00Z'), 0, 'closed by an administrator');
  assert.equal(run({ ...final, previousRoundCompletedAt: null }, '2026-09-29T15:00:00Z'), 0);
  assert.equal(run({ ...final, startsAt: at('2026-09-29T14:00:00Z') }, '2026-09-29T15:00:00Z'), 0, 'time was known');
});

test('notification wording, in the player’s time zone', () => {
  assert.equal(
    push.reopenedText('T2', Date.parse('2026-09-29T15:00:00Z'), 'Europe/Paris'),
    'Finale · horaire publié : pronostics rouverts jusqu’à 17:00',
  );
});

test('queued once per reopened match for players keeping new-match alerts', async () => {
  const upserts = [];
  const sub = { id: 's1', userId: 7, enabled: true, tournamentIds: [1], competitionIds: [], preferences: {} };
  const tx = {
    $queryRaw: async () => [],
    pushSubscription: { findUnique: async () => sub },
    pushDelivery: { upsert: async (q) => (upserts.push(q.create), q.create), updateMany: async () => ({}) },
    prediction: { findMany: async () => [] },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  const context = [{ competition: { id: 9, tournamentId: 1 }, matches: [], rounds: [], pools: [], reopened: [262] }];
  await push.queueSpecial(db, 's1', context);
  assert.deepEqual(
    upserts.map((u) => [u.kind, u.round, u.matchIds]),
    [['REOPENED', 'match-262', [262]]],
  );
  upserts.length = 0;
  sub.preferences = { newMatches: false, reminders: true };
  await push.queueSpecial(db, 's1', context);
  assert.equal(upserts.length, 0);
});

test('delivery: sent while the reopened match is still open and not yet predicted by the player', async () => {
  const start = new Date(Date.now() + 3600e3);
  const done = new Date(Date.now() - 3600e3);
  const matches = [
    { id: 260, competitionId: 9, round: 'T4', isFinished: true, resultRegisteredAt: done },
    { id: 261, competitionId: 9, round: 'T4', isFinished: true, resultRegisteredAt: done },
    { id: 262, competitionId: 9, round: 'T2', isFinished: false, startsAt: start },
  ];
  let own = 0;
  const statuses = [];
  const db = {
    match: { findMany: async () => matches },
    matchRound: {
      findMany: async () => [
        { competitionId: 9, round: 'T4', previousRound: 'T8', expectedMatchCount: 2 },
        { competitionId: 9, round: 'T2', previousRound: 'T4', expectedMatchCount: 1 },
      ],
    },
    prediction: { count: async () => own },
    pushDelivery: { updateMany: async (q) => (statuses.push(q.data.status), {}) },
  };
  const sub = { id: 's1', userId: 7, enabled: true, tournamentIds: [1], competitionIds: [], preferences: {} };
  const c = { id: 9, tournamentId: 1, name: 'Fleuret hommes' };
  const delivery = {
    id: 'd1',
    kind: 'REOPENED',
    round: 'match-262',
    matchIds: [262],
    createdAt: new Date(),
    attempts: 0,
  };
  const sent = [];
  await push.deliverSpecial(db, delivery, sub, c, [], async (s, content) => sent.push(content));
  assert.match(sent[0].body, /^Finale · horaire publié : pronostics rouverts jusqu’à \d\d:\d\d$/);
  assert.equal(sent[0].url, '/?tournament=1&event=9&matches=262');
  own = 1;
  await push.deliverSpecial(db, delivery, sub, c, [], async (s, content) => sent.push(content));
  assert.equal(sent.length, 1, 'already predicted: no alert');
  assert.deepEqual(statuses, ['SENT', 'CANCELLED']);
});
