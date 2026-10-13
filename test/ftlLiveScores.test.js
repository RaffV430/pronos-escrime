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

test('déroulé touche par touche : point de départ, touches, coup double, ordre de la rencontre', () => {
  const guids = new Set([GUID]);
  const at = Date.now();
  live.record(msg('9', 'ALPHA Anne', 'BRAVO Bea', 2, 1), at, guids);
  live.record(msg('9', 'ALPHA Anne', 'BRAVO Bea', 3, 1), at + 1, guids);
  live.record(msg('9', 'ALPHA Anne', 'BRAVO Bea', 3, 2), at + 2, guids);
  const s = live.record(msg('9', 'ALPHA Anne', 'BRAVO Bea', 4, 3), at + 3, guids);
  // La rencontre est enregistrée dans l'autre sens : BRAVO est player1.
  const [x] = live.matchLive([{ id: 5, player1: 'BRAVO Bea', player2: 'ALPHA Anne', isFinished: false }], [s], at + 4);
  assert.deepEqual(
    x.history.map((t) => [t.by, t.score1, t.score2]),
    [
      ['start', 1, 2],
      [2, 1, 3],
      [1, 2, 3],
      ['double', 3, 4],
    ],
  );
});

test('le score de la rencontre précédente sur la piste ne sert pas de point de départ', () => {
  const guids = new Set([GUID]);
  const at = Date.now();
  const fresh = (l, r, extra = {}) =>
    msg('Green', 'ISHI Take', 'SUAR Rica', l, r, { Clock: 180, PeriodNum: 1, ...extra });
  live.record(fresh(10, 7), at, guids); // noms changés, ancien score encore affiché
  live.record(fresh(0, 0), at + 1, guids); // remise à zéro
  const s = live.record(fresh(1, 0, { Clock: 170 }), at + 2, guids);
  const [x] = live.matchLive([{ id: 8, player1: 'ISHI Take', player2: 'SUAR Rica', isFinished: false }], [s], at + 3);
  assert.deepEqual(
    x.history.map((t) => [t.by, t.score1, t.score2]),
    [[1, 1, 0]],
  );
});
