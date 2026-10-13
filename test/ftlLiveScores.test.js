const { test } = require('node:test');
const assert = require('node:assert/strict');
const live = require('../src/services/ftlLiveScores');

const GUID = 'CD17BF3AC4CC47BC800AB3D2A503099C';
const msg = (strip, left, right, l, r, extra = {}) => ({
  TournGuid: GUID,
  StripNum: strip,
  Clock: 100,
  PeriodNum: 2,
  Left: { Name: left, Country: 'FRA', Score: l, ScoreLamp: true },
  Right: { Name: right, Country: '_AIN', Score: r },
  ...extra,
});

test('un état de piste est gardé seulement pour un tournoi suivi', () => {
  const guids = new Set([GUID]);
  assert.equal(live.record({ ...msg('1', 'A', 'B', 0, 0), TournGuid: 'AUTRE' }, 0, guids), null);
  const s = live.record(msg('Green', 'YOKOTA Keiichiro', 'KONCZYLO Tomasz', 6, 10), 1000, guids);
  assert.equal(s.strip, 'Green');
  assert.equal(s.right.country, 'AIN');
  assert.equal(s.left.lamp, true);
});

test('le score est rattaché au bon match, dans l’ordre player1 / player2, accents et casse ignorés', () => {
  const now = 10_000;
  const states = [
    { ...live.record(msg('5', 'LEZHAVA NIKOLOZ', 'GOHY Cédric', 4, 3), now, new Set([GUID])) },
    { ...live.record(msg('Blue', 'GASTIERER Helmut', 'HEGEDUS Sandor', 4, 7), now, new Set([GUID])) },
  ];
  const matches = [
    { id: 1, player1: 'GOHY Cedric', player2: 'LEZHAVA Nikoloz', isFinished: false },
    { id: 2, player1: 'GASTIERER Helmut', player2: 'HEGEDUS Sandor', isFinished: true },
    { id: 3, player1: 'X Y', player2: 'Z W', isFinished: false },
  ];
  const out = live.matchLive(matches, states, now);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].matchId, out[0].score1, out[0].score2, out[0].strip], [1, 3, 4, '5']);
});

test('une piste muette depuis plus de 3 minutes n’est plus en cours', () => {
  const s = live.record(msg('7', 'A B', 'C D', 1, 0), 0, new Set([GUID]));
  const m = [{ id: 9, player1: 'A B', player2: 'C D', isFinished: false }];
  assert.equal(live.matchLive(m, [s], live.FRESH_MS).length, 1);
  assert.equal(live.matchLive(m, [s], live.FRESH_MS + 1).length, 0);
});
