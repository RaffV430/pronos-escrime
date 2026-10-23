const { test } = require('node:test');
const assert = require('node:assert/strict');
const push = require('../src/services/pushNotifications');

function setup(kind = 'FENCER_RESULT', options = {}) {
  const name = 'EXEMPLE Alex';
  const sub = {
    id: 'test-sub',
    userId: 7,
    enabled: true,
    tournamentIds: [1],
    competitionIds: [],
    preferences: { v: 2, fencerResults: true, recap: true, quietEnabled: false, ...options.preferences },
  };
  const competition = {
    id: 3,
    tournamentId: 1,
    name: 'Épreuve fictive',
    podiumRoster: [{ id: 'a', name, country: 'FRA' }],
  };
  const result = {
    id: 41,
    player1: name,
    player2: 'AUTRE Camille',
    round: 'T32',
    winner: 1,
    score1: 15,
    score2: 11,
    isFinished: true,
    pointsPending: false,
    resultType: 'NORMAL',
    ...options.result,
  };
  const delivery = {
    id: 'test-delivery',
    kind,
    round: 'match-41',
    matchIds: [41],
    createdAt: new Date(Date.now() - (options.age || 1000)),
    attempts: 1,
  };
  const sent = [],
    updates = [];
  // Pas de modèle de pronostics/points en écriture, ni d'expéditeur réseau dans cette base factice.
  const db = {
    followedFencer: {
      findMany: async () => [{ id: 1, name, country: 'FRA', club: '', originCompetitionId: 3, originEntryId: 'a' }],
    },
    match: { findUnique: async () => result },
    competition: { findUnique: async () => competition },
    pool: {
      findUnique: async () => ({
        isFinal: true,
        name: 'Poule fictive',
        fencers: [{ name, wins: 5, losses: 1, indicator: 12 }],
      }),
    },
    pushDelivery: {
      updateMany: async (q) => {
        updates.push(q.data);
        return { count: 1 };
      },
    },
  };
  const send = async (s, content, ttl, urgency) => sent.push({ content, ttl, urgency });
  return { db, sub, competition, result, delivery, sent, updates, send };
}
const deliver = (s, send = s.send) => push.deliverSpecial(s.db, s.delivery, s.sub, s.competition, [], send);

test('favorite bout results request immediate delivery without changing text, link or lifetime', async () => {
  const s = setup();
  const before = JSON.stringify([s.result, s.competition, s.sub, s.delivery]);
  await deliver(s);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].urgency, 'high');
  assert.equal(s.sent[0].ttl, 3600);
  assert.equal(s.sent[0].content.body, '✅ EXEMPLE Alex passe en T16 (15–11 contre AUTRE Camille)');
  assert.equal(s.sent[0].content.url, '/direct/1/3');
  assert.equal(s.sent[0].content.tag, 'pronos-test-delivery');
  assert.equal(s.updates[0].status, 'SENT');
  assert.equal(JSON.stringify([s.result, s.competition, s.sub, s.delivery]), before);
});

test('favorite pool summaries keep normal priority', async () => {
  const s = setup('FENCER_POOL');
  await deliver(s);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].urgency, 'normal');
  assert.equal(s.sent[0].ttl, 3600);
});

test('end-of-event recaps keep normal priority', async (t) => {
  const personal = require('../src/routes/personalRoutes');
  t.mock.method(personal, 'competitionRecap', async () => ({ predictions: 1, points: 6, rank: 1, players: 2 }));
  const s = setup('RECAP');
  await deliver(s);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].urgency, 'normal');
  assert.equal(s.sent[0].content.body, 'Épreuve terminée · 6 points · 1er sur 2 · votre récap est prêt');
});

test('high priority does not bypass opt-out, quiet hours or result validation', async () => {
  const at = new Date();
  const hour = at.getUTCHours();
  const hh = (h) => String((h + 24) % 24).padStart(2, '0') + ':00';
  const cases = [
    { preferences: { fencerResults: false } },
    { preferences: { quietEnabled: true, quietStart: hh(hour - 1), quietEnd: hh(hour + 2), timezone: 'UTC' } },
    { result: { pointsPending: true } },
    { result: { isFinished: false } },
    { result: { resultType: 'CANCELLED' } },
    { result: { player1: 'AUTRE Fictif' } },
    { age: 3600001 },
  ];
  for (const input of cases) {
    const s = setup('FENCER_RESULT', input);
    await deliver(s);
    assert.equal(s.sent.length, 0, JSON.stringify(input));
    assert.equal(s.updates[0].status, 'CANCELLED');
  }
});

test('a temporary push failure retains the existing retry policy and never reports success', async () => {
  const s = setup();
  const start = Date.now();
  await deliver(s, async (sub, content, ttl, urgency) => {
    assert.equal(urgency, 'high');
    throw Object.assign(new Error('simulated temporary failure'), { statusCode: 503 });
  });
  assert.equal(s.updates[0].status, 'PENDING');
  assert.ok(s.updates[0].nextAttemptAt.getTime() >= start + 120000);
  assert.equal(
    s.updates.some((u) => u.status === 'SENT'),
    false,
  );
});

test('the web-push adapter forwards high and normal urgency without a real network call', async (t) => {
  const webpush = require('web-push');
  const calls = [];
  t.mock.method(webpush, 'sendNotification', async (sub, body, options) => {
    calls.push({ body, options });
    return { statusCode: 201 };
  });
  const subscription = { endpoint: 'https://example.invalid/test', p256dh: 'test', auth: 'test' };
  for (const urgency of ['high', 'normal']) await push.send(subscription, { title: 'Test' }, 3600, urgency);
  assert.deepEqual(
    calls.map((c) => c.options.urgency),
    ['high', 'normal'],
  );
  assert.ok(calls.every((c) => c.options.TTL === 3600 && c.options.timeout === 7000));
});
