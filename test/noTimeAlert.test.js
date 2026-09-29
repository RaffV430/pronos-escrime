const test = require('node:test');
const assert = require('node:assert/strict');
const { closedWithoutTime, alertClosedWithoutTime, NO_TIME_ACTION } = require('../src/services/syncHealth');

const now = Date.parse('2026-09-29T12:00:00Z');
const base = {
  id: 262,
  competitionId: 9,
  round: 'T2',
  player1: 'DOSA DANIEL',
  player2: 'ROGER WALLERAND',
  startsAt: null,
  isFinished: false,
  previousRoundCompletedAt: '2026-09-29T11:30:35Z',
};

test('final phases closed for lack of time are detected, nothing else', () => {
  assert.deepEqual(
    closedWithoutTime([base], now).map((m) => m.id),
    [262],
  );
  const none = (m) => closedWithoutTime([{ ...base, ...m }], now).length;
  assert.equal(none({ round: 'T8' }), 0, 'earlier rounds are not alerted');
  assert.equal(none({ startsAt: '2026-09-29T15:00:00Z' }), 0, 'time published');
  assert.equal(none({ isFinished: true }), 0);
  assert.equal(none({ isLocked: true }), 0, 'closed by an administrator');
  assert.equal(none({ previousRoundCompletedAt: '2026-09-29T11:55:00Z' }), 0, 'still open');
  assert.equal(none({ player2: ' ' }), 0, 'opponent unknown');
  assert.deepEqual(
    closedWithoutTime(
      [
        { ...base, round: 'T4' },
        { ...base, id: 3, round: 'Bronze' },
      ],
      now,
    ).length,
    2,
  );
});

test('admins alerted once per match, by mail and push, with a link to the match', async () => {
  const audit = [];
  const mails = [];
  const pushes = [];
  const db = {
    match: {
      findMany: async () => [
        { id: 260, competitionId: 9, round: 'T4', isFinished: true, resultRegisteredAt: '2026-09-29T11:25:00Z' },
        { id: 261, competitionId: 9, round: 'T4', isFinished: true, resultRegisteredAt: '2026-09-29T11:30:35Z' },
        { ...base, previousRoundCompletedAt: undefined },
      ],
    },
    matchRound: {
      findMany: async () => [
        { competitionId: 9, round: 'T4', previousRound: null, expectedMatchCount: 2 },
        { competitionId: 9, round: 'T2', previousRound: 'T4', expectedMatchCount: 2 },
      ],
    },
    auditLog: {
      findMany: async ({ where }) =>
        audit.filter((a) => a.action === where.action && where.targetId.in.includes(a.targetId)),
      create: async ({ data }) => (audit.push(data), data),
    },
    user: { findMany: async () => [{ id: 1, email: 'admin@example.test', name: 'Admin' }] },
    pushSubscription: { findMany: async () => [{ id: 's1' }] },
  };
  const deps = {
    now,
    mailer: { mailConfigured: () => true, sendMail: async (m) => mails.push(m) },
    push: { configured: () => true, send: async (sub, content) => pushes.push(content) },
  };
  const competition = { id: 9, name: "Senior Men's Foil", tournamentId: 2 };
  assert.deepEqual(await alertClosedWithoutTime(db, competition, deps), [262]);
  assert.equal(pushes[0].title, "Finale close sans horaire · Senior Men's Foil");
  assert.match(pushes[0].body, /^DOSA DANIEL \/ ROGER WALLERAND : pronostics clos à 13:40 /);
  assert.equal(pushes[0].url, '/?tournament=2&event=9&matches=262');
  assert.equal(mails.length, 1);
  assert.equal(audit[0].action, NO_TIME_ACTION);
  assert.deepEqual(await alertClosedWithoutTime(db, competition, deps), [], 'only once');
  assert.equal(pushes.length, 1);
});
