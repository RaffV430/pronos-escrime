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
  assert.equal(out[0].ftlLeftPlayer, 2);
  assert.deepEqual([out[0].matchId, out[0].score1, out[0].score2, out[0].strip], [1, 3, 4, '5']);
});

test('une piste muette depuis plus de 3 minutes n’est plus en cours', () => {
  const s = live.record(msg('7', 'A B', 'C D', 1, 0), 0, new Set([GUID]));
  const m = [{ id: 9, player1: 'A B', player2: 'C D', isFinished: false }];
  assert.equal(live.matchLive(m, [s], live.FRESH_MS)[0].ftlLeftPlayer, 1);
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

test('équipes : pays et piste rattachent les scores cumulés malgré le changement de relayeur', () => {
  const now = 90000;
  const m = {
    id: 901,
    player1: 'TEAM A',
    player2: 'TEAM B',
    player1Country: 'FRA',
    player2Country: 'ITA',
    podiumFormat: 'TEAM',
    strip: '19',
    isFinished: false,
  };
  const state = live.record(
    {
      ...msg('19', 'RELAY A', 'RELAY B', 31, 29),
      Left: { Name: 'RELAY A', Country: 'ITA', Score: 31 },
      Right: { Name: 'RELAY B', Country: 'FRA', Score: 29 },
    },
    now,
    new Set([GUID]),
  );
  const snapshot = structuredClone(m);
  const [result] = live.matchLive([m], [state], now);
  assert.deepEqual([result.matchId, result.score1, result.score2], [901, 29, 31]);
  const relay = { ...state, left: { ...state.left, name: 'NEXT RELAY' } };
  assert.equal(live.matchLive([m], [relay], now)[0].matchId, 901);
  assert.deepEqual(m, snapshot);
  assert.equal(live.matchLive([{ ...m, podiumFormat: 'INDIVIDUAL' }], [state], now).length, 0);
  for (const match of [
    { ...m, strip: '20' },
    { ...m, strip: null },
    { ...m, player1Country: null },
    { ...m, player2Country: 'FRA' },
  ])
    assert.equal(live.matchLive([match], [state], now).length, 0);
  assert.equal(live.matchLive([m, { ...m, id: 902 }], [state], now).length, 0);
  assert.equal(live.matchLive([m], [state, { ...state }], now).length, 0);
  assert.equal(live.matchLive([m], [state], now + live.FRESH_MS + 1).length, 0);
});

test('liveFor utilise le format, les pays officiels et la piste de la base sans écrire de résultat', async () => {
  const now = 200000;
  const match = { id: 950, player1: 'TEAM ONE', player2: 'TEAM TWO', strip: '42', isFinished: false };
  const db = {
    competition: {
      findUnique: async () => ({
        podiumFormat: 'TEAM',
        podiumRoster: [
          { name: 'TEAM ONE', country: 'GER' },
          { name: 'TEAM TWO', country: 'ITA' },
        ],
        tournament: { ftlSourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${GUID}` },
      }),
    },
    match: { findMany: async () => [match] },
  };
  live.record(
    {
      ...msg('42', 'FIRST RELAY', 'SECOND RELAY', 35, 32),
      Left: { Name: 'FIRST RELAY', Country: 'GER', Score: 35 },
      Right: { Name: 'SECOND RELAY', Country: 'ITA', Score: 32 },
    },
    now,
    new Set([GUID]),
  );
  const result = await live.liveFor(db, 950, now);
  assert.deepEqual(
    result.map((x) => [x.matchId, x.score1, x.score2]),
    [[950, 35, 32]],
  );
  assert.deepEqual(match, { id: 950, player1: 'TEAM ONE', player2: 'TEAM TWO', strip: '42', isFinished: false });
});

test('la même affiche dans deux phases n’entraîne jamais deux verrous live', () => {
  const now = Date.now();
  const s = live.record(msg('live-ambiguity', 'LIVE X', 'LIVE Y', 0, 0), now, new Set([GUID]));
  const matches = [
    { id: 981001, player1: 'LIVE X', player2: 'LIVE Y', round: 'J1:T64' },
    { id: 981002, player1: 'LIVE X', player2: 'LIVE Y', round: 'T64' },
  ];
  assert.deepEqual(live.matchLive(matches, [s], now), []);
  const assigned = matches.map((m, i) => ({ ...m, strip: i ? 'other' : 'live-ambiguity' }));
  assert.deepEqual(
    live.matchLive(assigned, [s], now).map((x) => x.matchId),
    [981001],
  );
});

test(
  'le worker verrouille la rencontre détectée sans abonné et sans autre synchronisation',
  { timeout: 3000 },
  async () => {
    const old = process.env.FTL_AUTO_SYNC;
    process.env.FTL_AUTO_SYNC = 'true';
    const match = {
      id: 981100,
      competitionId: 981100,
      player1: 'WORKER ALPHA',
      player2: 'WORKER BETA',
      isFinished: false,
      liveDetectedAt: null,
    };
    let handler, written;
    const saved = new Promise((resolve) => (written = resolve));
    const db = {
      tournament: {
        findMany: async () => [
          {
            ftlSourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${GUID}`,
            competitions: [{ id: 981100 }],
          },
        ],
      },
      competition: {
        findUnique: async () => ({
          tournament: { ftlSourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${GUID}` },
        }),
      },
      match: {
        findMany: async () => [match],
        updateMany: async (args) => {
          written(args);
          return { count: 1 };
        },
      },
    };
    const stop = live.startWorker(db, { connect: () => ({ on: (_event, cb) => (handler = cb), close: () => {} }) });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      handler(msg('worker-test', match.player1, match.player2, 0, 0));
      const result = await saved;
      assert.deepEqual(result.where, {
        id: match.id,
        player1: match.player1,
        player2: match.player2,
        isFinished: false,
        liveDetectedAt: null,
      });
      assert.ok(result.data.liveDetectedAt instanceof Date);
      assert.deepEqual(Object.keys(result.data), ['liveDetectedAt']);
    } finally {
      stop();
      if (old === undefined) delete process.env.FTL_AUTO_SYNC;
      else process.env.FTL_AUTO_SYNC = old;
    }
  },
);
test('le déroulé terminé suit les identités conservées, même si la rencontre change de sens', () => {
  const at = 120000,
    guids = new Set([GUID]);
  const match = { id: 9901, player1: 'SYNTH ALPHA', player2: 'SYNTH BRAVO', isFinished: false };
  live.record(msg('history-order', 'SYNTH BRAVO', 'SYNTH ALPHA', 0, 0), at, guids);
  live.record(msg('history-order', 'SYNTH BRAVO', 'SYNTH ALPHA', 0, 1), at + 1, guids);
  const state = live.record(msg('history-order', 'SYNTH BRAVO', 'SYNTH ALPHA', 8, 15), at + 2, guids);
  const before = structuredClone(match);
  live.matchLive([match], [state], at + 3);
  const done = { ...match, isFinished: true, score1: 15, score2: 8 };
  const [a] = live.matchLive([done], [], at + 4);
  assert.deepEqual([a.history.at(-1).score1, a.history.at(-1).score2], [15, 8]);
  const [b] = live.matchLive(
    [{ ...done, player1: match.player2, player2: match.player1, score1: 8, score2: 15 }],
    [],
    at + 5,
  );
  assert.deepEqual([b.history[0].by, b.history.at(-1).score1, b.history.at(-1).score2], [2, 8, 15]);
  assert.deepEqual(match, before);
  assert.deepEqual(live.matchLive([done], [], at + 6)[0].history, a.history);
  const [other] = live.matchLive([{ ...done, player2: 'SYNTH CHARLIE' }], [], at + 7);
  assert.deepEqual(other.history, []);
  assert.match(other.historyIssue, /tireurs/);
});

test('un déroulé contradictoire est signalé sans inventer une inversion à partir du score final', () => {
  const at = 140000,
    guids = new Set([GUID]);
  const match = { id: 9902, player1: 'SYNTH DELTA', player2: 'SYNTH ECHO', isFinished: false };
  live.record(msg('history-conflict', match.player1, match.player2, 0, 0), at, guids);
  const state = live.record(msg('history-conflict', match.player1, match.player2, 8, 15), at + 1, guids);
  live.matchLive([match], [state], at + 2);
  const done = { ...match, isFinished: true, score1: 15, score2: 8 };
  const before = structuredClone(done);
  const [bad] = live.matchLive([done], [], at + 3);
  assert.deepEqual(bad.history, []);
  assert.match(bad.historyIssue, /résultat officiel/);
  assert.deepEqual(done, before);
  const [valid] = live.matchLive([{ ...done, score1: 8, score2: 15 }], [], at + 4);
  assert.equal(valid.history.at(-1).by, 'double');
  assert.equal(valid.historyIssue, undefined);
});

test('un déroulé partiel cohérent reste affichable après publication du résultat', () => {
  const at = 160000,
    guids = new Set([GUID]);
  const match = { id: 9903, player1: 'SYNTH FOXTROT', player2: 'SYNTH GOLF', isFinished: false };
  const state = live.record(msg('history-partial', match.player1, match.player2, 4, 3), at, guids);
  live.matchLive([match], [state], at + 1);
  const [done] = live.matchLive([{ ...match, isFinished: true, score1: 15, score2: 8 }], [], at + 2);
  assert.equal(done.history.at(-1).score1, 4);
  assert.equal(done.historyIssue, undefined);
});

test('affiche préchargée : verrouillage seulement au chrono entamé, conservé après remise à 3:00', async () => {
  const at = 180000,
    guids = new Set([GUID]);
  const matches = [
    { id: 9971, player1: 'CLOCK ALPHA', player2: 'CLOCK BETA', isFinished: false, liveDetectedAt: null },
    { id: 9972, player1: 'CLOCK GAMMA', player2: 'CLOCK DELTA', isFinished: false, liveDetectedAt: null },
  ];
  const first = live.record(
    msg('clock-1', matches[0].player1, matches[0].player2, 0, 0, { Clock: 180, PeriodNum: 1 }),
    at,
    guids,
  );
  const other = live.record(
    msg('clock-2', matches[1].player1, matches[1].player2, 0, 0, { Clock: 180, PeriodNum: 1 }),
    at,
    guids,
  );
  assert.deepEqual(
    live.matchLive(matches, [first, other], at).map((m) => m.started),
    [false, false],
  );
  const running = live.record(
    msg('clock-1', matches[0].player1, matches[0].player2, 0, 0, { Clock: 179, PeriodNum: 1 }),
    at + 1,
    guids,
  );
  assert.deepEqual(
    live.matchLive(matches, [running, other], at + 1).map((m) => m.started),
    [true, false],
  );
  const paused = live.record(
    msg('clock-1', matches[0].player1, matches[0].player2, 0, 0, { Clock: 180, PeriodNum: 1 }),
    at + 2,
    guids,
  );
  assert.equal(live.matchLive(matches, [paused], at + 2)[0].started, true);
});

test('une horloge absente ou initialisée à zéro sans touche ne prouve pas un départ', () => {
  const at = 190000,
    guids = new Set([GUID]);
  for (const [i, clock] of [null, 0, 180].entries()) {
    const match = { id: 9980 + i, player1: `CLOCK IDLE ${i}`, player2: `CLOCK WAIT ${i}`, isFinished: false };
    const state = live.record(
      msg(`idle-${i}`, match.player1, match.player2, 0, 0, { Clock: clock, PeriodNum: 1 }),
      at,
      guids,
    );
    assert.equal(live.matchLive([match], [state], at)[0].started, false);
  }
});

test('team history retains earlier relays, names and corrections without changing the official match', () => {
  const at = Date.now(),
    guids = new Set([GUID]);
  const match = {
    id: 1991,
    player1: 'SYNTH TEAM A',
    player2: 'SYNTH TEAM B',
    player1Country: 'FRA',
    player2Country: 'ITA',
    podiumFormat: 'TEAM',
    strip: 'relay-history',
    isFinished: false,
  };
  const snapshot = structuredClone(match);
  const send = (l, r, n, period, left = 'SYNTH A', right = 'SYNTH B') =>
    live.record(
      msg('relay-history', left, right, l, r, {
        PeriodNum: period,
        Left: { Name: left, Country: 'FRA', Score: l },
        Right: { Name: right, Country: 'ITA', Score: r },
      }),
      at + n,
      guids,
    );
  let state = send(3, 2, 1, 1);
  live.matchLive([match], [state], at + 1);
  state = send(4, 2, 2, 1);
  live.matchLive([match], [state], at + 2);
  state = send(4, 2, 3, 2, 'SYNTH C', 'SYNTH D');
  live.matchLive([match], [state], at + 3);
  state = send(4, 3, 4, 2, 'SYNTH C', 'SYNTH D');
  const result = live.matchLive([match], [state], at + 4)[0];
  assert.deepEqual(
    result.history.map((x) => x.by),
    ['start', 1, 'relay', 2],
  );
  assert.equal(result.history[1].fencer1Name, 'SYNTH A');
  assert.equal(result.history.at(-1).fencer1Name, 'SYNTH C');
  assert.deepEqual(match, snapshot);
  const done = live.matchLive([{ ...match, isFinished: true, score1: 4, score2: 3 }], [], at + 5)[0];
  assert.deepEqual(done.history, result.history);
  const reversed = live.matchLive(
    [{ ...match, isFinished: true, player1: match.player2, player2: match.player1, score1: 3, score2: 4 }],
    [],
    at + 6,
  )[0];
  assert.equal(reversed.history.at(-1).fencer1Name, 'SYNTH D');
  assert.equal(reversed.history.at(-1).by, 1);
});
