const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headToHead, fromSide } = require('../src/services/headToHead');

const m = (id, p1, p2, s1, s2, extra = {}) => ({
  id,
  player1: p1,
  player2: p2,
  score1: s1,
  score2: s2,
  winner: s1 > s2 ? 1 : 2,
  round: 'T16',
  startsAt: new Date(`2026-0${id}-01T10:00:00Z`),
  competition: { name: 'Fleuret hommes', tournament: { name: `Tournoi ${id}` } },
  ...extra,
});

test('results are always read from the requested fencer’s side, whatever the order on the sheet', () => {
  const r = fromSide(m(1, 'KOROM Erik', 'SAVIN Rafael', 12, 15), 'savin rafael');
  assert.deepEqual([r.won, r.score, r.opponent], [true, [15, 12], 'KOROM Erik']);
  const medical = fromSide(
    m(2, 'SAVIN Rafael', 'BEM Maciej', null, null, { winner: 2, resultType: 'MEDICAL_WITHDRAWAL' }),
    'SAVIN Rafael',
  );
  assert.deepEqual([medical.won, medical.score, medical.medical], [false, null, true]);
});

test('head-to-head: past meetings in both orders, summary and recent form; the current bout is excluded', async () => {
  const history = [
    m(3, 'SAVIN Rafael', 'KOROM Erik', 15, 9),
    m(2, 'KOROM Erik', 'SAVIN Rafael', 15, 14),
    m(1, 'SAVIN Rafael', 'BEM Maciej', 15, 3),
  ];
  const calls = [];
  const db = {
    match: {
      findUnique: async () => ({ id: 99, player1: 'SAVIN Rafael', player2: 'KOROM Erik' }),
      findMany: async (args) => {
        calls.push(args);
        const where = JSON.stringify(args.where);
        const pair = where.includes('"player2":{"equals":"KOROM Erik"');
        return pair ? history.slice(0, 2) : where.includes('SAVIN') ? history : history.slice(0, 2);
      },
    },
  };
  const out = await headToHead(db, 99);
  assert.deepEqual(out.summary, { wins1: 1, wins2: 1 });
  assert.deepEqual(
    out.meetings.map((x) => [x.tournament, x.score]),
    [
      ['Tournoi 3', [15, 9]],
      ['Tournoi 2', [14, 15]],
    ],
  );
  assert.equal(out.form.player1.length, 3);
  assert.ok(
    calls.every((c) => JSON.stringify(c.where).includes('"id":{"not":99}')),
    'the bout itself is never counted',
  );
  assert.ok(calls.every((c) => JSON.stringify(c.where).includes('"mode":"insensitive"')));
});

test('unknown match → 404; bout without both names → empty history', async () => {
  await assert.rejects(headToHead({ match: { findUnique: async () => null } }, 1), /introuvable/);
  const empty = await headToHead(
    { match: { findUnique: async () => ({ id: 1, player1: 'SAVIN Rafael', player2: '' }) } },
    1,
  );
  assert.deepEqual(empty.meetings, []);
});
