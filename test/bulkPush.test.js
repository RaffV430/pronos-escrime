const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const bulk = require('../src/services/ftlTournament'),
  push = require('../src/services/pushNotifications'),
  { createClient } = require('../src/services/ftlClient');
const source = 'https://www.fencingtimelive.com/tournaments/eventSchedule/37728717D8234487A9BA770AD4FA9492';
const html = fs.readFileSync(`${__dirname}/fixtures/ftl-schedule.html`, 'utf8');
test('one official schedule identifies all six events, local dates and team formats', () => {
  const p = bulk.parseSchedule(html, source, 'Europe/Istanbul');
  assert.equal(p.events.length, 6);
  assert.equal(p.events.filter((e) => e.format === 'TEAM').length, 2);
  assert.equal(p.events[5].date, '2026-09-27');
  assert.equal(p.events[5].time, '11:00 AM');
  assert.equal(p.events[3].eventId, '3E02F3DE23C54C7683C06B07F23E85F4');
  assert.equal(bulk.scheduleUrl(source + '#today'), source);
  assert.throws(() => bulk.scheduleUrl('https://evil.example/' + source), /SCHEDULE/);
  assert.throws(() => bulk.parseSchedule(html, source, 'Mars/Here'), /Fuseau/);
  assert.throws(
    () => bulk.parseSchedule(html.replace('id="ev_', 'id="ev_invalid'), source, 'Europe/Istanbul'),
    /ambigu/,
  );
});
test('event redirects never carry the authenticated session outside FTL or to another event', async () => {
  const event = 'A'.repeat(32),
    round = 'B'.repeat(32),
    calls = [];
  const client = createClient({
    http: {
      request: async ({ url }) => {
        calls.push(url);
        return url.includes('/events/view/')
          ? { status: 302, headers: { location: `/tableaus/scores/${event}/${round}` } }
          : { status: 200, headers: {}, data: '<h1>Event</h1>' };
      },
    },
  });
  assert.equal(
    (await client.eventPage(`/events/view/${event}`)).url,
    `https://www.fencingtimelive.com/tableaus/scores/${event}/${round}`,
  );
  assert.equal(calls.length, 2);
  for (const location of ['https://evil.example/', `/tableaus/scores/${round}/${event}`, '/account/login']) {
    const unsafe = createClient({ http: { request: async () => ({ status: 302, headers: { location } }) } });
    await assert.rejects(unsafe.eventPage(`/events/view/${event}`), /Redirection/);
  }
});
test('push endpoints reject SSRF, credentials, wrong keys and invalid scopes', () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth = Buffer.alloc(16, 2).toString('base64url');
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: key, auth } };
  assert.equal(push.validateSubscription(good).p256dh, key);
  for (const endpoint of [
    'http://fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://127.0.0.1/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8080/x',
  ])
    assert.throws(() => push.validateSubscription({ ...good, endpoint }), /reconnu/);
  assert.throws(() => push.validateSubscription({ ...good, keys: { p256dh: 'abc', auth } }), /invalide/);
  // Sans sélection : autorisé, l'appareil suit alors tous les tournois (préférence followAll).
  assert.deepEqual(push.validateScopes({}), { tournamentIds: [], competitionIds: [] });
  assert.throws(() => push.validateScopes({ tournamentIds: ['1'] }), /invalide/);
  assert.deepEqual(push.validateScopes({ tournamentIds: [1, 1], competitionIds: [3] }), {
    tournamentIds: [1],
    competitionIds: [3],
  });
});
test('following a tournament includes future events but unrelated events stay excluded', () => {
  const own = { tournamentIds: [1], competitionIds: [], preferences: { followAll: false } };
  assert.ok(push.follows(own, { id: 999, tournamentId: 1 }));
  assert.ok(!push.follows(own, { id: 999, tournamentId: 2 }));
  // Par défaut, un appareil suit tous les tournois, y compris ceux créés après son activation.
  assert.ok(push.follows({ tournamentIds: [1], competitionIds: [] }, { id: 999, tournamentId: 2 }));
  const data = push.payload({ id: 5, tournamentId: 1, name: 'Junior Team Women' }, [{ id: 4 }, { id: 9 }], 'batch');
  assert.match(data.url, /event=5&new=1&matches=4,9/);
  assert.equal(data.tag, 'pronos-batch');
});
test('legacy event cursor advances without queuing per-import alerts', async () => {
  const sub = { id: 's', enabled: true, lastEventId: 0, tournamentIds: [1], competitionIds: [] },
    deliveries = [];
  const events = [1, 2, 3].map((id) => ({ id, matchId: id, competitionId: 5, createdAt: new Date() }));
  const db = {
    $queryRaw: async () => [],
    pushSubscription: { findUnique: async () => sub, update: async ({ data }) => Object.assign(sub, data) },
    pushEvent: { findMany: async ({ where }) => events.filter((e) => e.id > where.id.gt) },
    competition: { findMany: async () => [{ id: 5, tournamentId: 1 }] },
    match: {
      findMany: async () =>
        events.map((e) => ({
          id: e.id,
          competitionId: 5,
          round: 'T4',
          isFinished: e.id === 3,
          startsAt: new Date(Date.now() + 3600000),
        })),
    },
    matchRound: {
      findMany: async () => [{ competitionId: 5, round: 'T4', previousRound: null, expectedMatchCount: 3 }],
    },
    pushDelivery: { create: async ({ data }) => deliveries.push(data) },
  };
  db.$transaction = (f) => f(db);
  await push.queueForSubscription(db, 's');
  await push.queueForSubscription(db, 's');
  assert.equal(deliveries.length, 0);
  assert.equal(sub.lastEventId, 3);
});
test('delivery rechecks closure, disables expired endpoints and sends only once after success', async () => {
  const sub = { id: 's', enabled: true, tournamentIds: [1], competitionIds: [] };
  const row = {
    id: 'd',
    subscriptionId: 's',
    competitionId: 5,
    matchIds: [7],
    status: 'PENDING',
    attempts: 0,
    createdAt: new Date(),
    nextAttemptAt: new Date(0),
  };
  let finished = false,
    sent = 0;
  const db = {
    $queryRaw: async () => [],
    pushDelivery: {
      findUnique: async () => ({ ...row }),
      update: async ({ data }) => Object.assign(row, data),
      updateMany: async ({ where, data }) => {
        if (row.status === where.status) Object.assign(row, data);
      },
    },
    pushSubscription: { findUnique: async () => sub, update: async ({ data }) => Object.assign(sub, data) },
    competition: { findUnique: async () => ({ id: 5, tournamentId: 1, name: 'Test' }) },
    match: {
      findMany: async () => [
        { id: 7, competitionId: 5, round: 'T2', isFinished: finished, startsAt: new Date(Date.now() + 3600000) },
      ],
    },
    matchRound: {
      findMany: async () => [{ competitionId: 5, round: 'T2', previousRound: null, expectedMatchCount: 1 }],
    },
  };
  db.$transaction = (f) => f(db);
  await push.deliver(db, 'd', async () => {
    sent++;
  });
  await push.deliver(db, 'd', async () => {
    sent++;
  });
  assert.equal(sent, 1);
  assert.equal(row.status, 'SENT');
  row.status = 'PENDING';
  finished = true;
  await push.deliver(db, 'd', async () => assert.fail('closed'));
  assert.equal(row.status, 'CANCELLED');
  row.status = 'PENDING';
  row.attempts = 0;
  finished = false;
  await push.deliver(db, 'd', async () => {
    throw { statusCode: 410 };
  });
  assert.equal(sub.enabled, false);
  assert.equal(row.status, 'FAILED');
});
test('réinscription sur la nouvelle adresse : l’ancienne inscription du même navigateur est remplacée', async () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth = Buffer.alloc(16, 2).toString('base64url');
  const before = new Date(push.DOMAIN_SWITCH - 86400000);
  const rows = [
    { id: 'old-fcm', userId: 7, enabled: true, endpoint: 'https://fcm.googleapis.com/fcm/send/old', createdAt: before },
    { id: 'old-apple', userId: 7, enabled: true, endpoint: 'https://web.push.apple.com/old', createdAt: before },
  ];
  const cancelled = [];
  const tx = {
    $queryRaw: async () => [],
    pushEvent: { findFirst: async () => ({ id: 3 }) },
    pushDelivery: { updateMany: async ({ where }) => cancelled.push(where.subscriptionId) },
    pushSubscription: {
      findUnique: async () => null,
      count: async () => rows.filter((r) => r.enabled).length,
      upsert: async ({ create }) => {
        const row = { id: 'new', enabled: true, createdAt: new Date(), ...create };
        rows.push(row);
        return row;
      },
      findMany: async ({ where }) =>
        rows.filter(
          (r) => r.userId === where.userId && r.enabled && r.id !== where.id.not && r.createdAt < where.createdAt.lt,
        ),
      updateMany: async ({ where, data }) =>
        rows.filter((r) => where.id.in.includes(r.id)).forEach((r) => Object.assign(r, data)),
    },
  };
  const db = {
    tournament: { count: async () => 0 },
    competition: { count: async () => 0 },
    $transaction: (fn) => fn(tx),
  };
  const out = await push.subscribe(db, 7, {
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: key, auth } },
    replaceLegacy: true,
  });
  assert.equal(out.replaced, 1);
  assert.equal(out.preferences.followAll, true);
  assert.deepEqual(
    rows.map((r) => [r.id, r.enabled]),
    [
      ['old-fcm', false],
      ['old-apple', true],
      ['new', true],
    ],
  );
  // Sans « suivre tous les tournois », une sélection reste obligatoire.
  await assert.rejects(
    () =>
      push.subscribe(db, 7, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: key, auth } },
        preferences: { followAll: false },
      }),
    /Choisissez/,
  );
});

test('récap de fin d’épreuve : activé par défaut, texte avec classement et vainqueurs trouvés', () => {
  const { preferences } = require('../src/services/playerExperience');
  assert.equal(preferences({}).recap, true);
  assert.equal(
    push.recapText({ points: 23, rank: 4, players: 18, winners: 6, played: 9 }),
    'Épreuve terminée · 23 points · 4e sur 18 · 6 vainqueurs trouvés sur 9 · votre récap est prêt',
  );
  const { confirmedNotification } = require('../src/services/poolRoundAlerts');
  const n = confirmedNotification({ id: 2, tournamentId: 1, name: 'Fleuret Dames' }, [{ lockMode: 'FIRST_RESULT' }]);
  assert.match(n.body, /définitif.*premier résultat/);
});
