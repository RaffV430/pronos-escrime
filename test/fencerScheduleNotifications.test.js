const test = require('node:test');
const assert = require('node:assert/strict');
const {
  upcomingMatch,
  upcomingPool,
  scheduleText,
  queueSchedules,
} = require('../src/services/fencerScheduleNotifications');
const { preferences } = require('../src/services/playerExperience');
const push = require('../src/services/pushNotifications');
const now = Date.now();
const future = new Date(now + 3600000);
const c = { id: 9, tournamentId: 1, name: 'Fleuret', podiumRoster: [{ id: 'a', name: 'MARTIN Léa', country: 'FRA' }] };
const favorite = { id: 1, name: 'MARTIN Léa', country: 'FRA', originCompetitionId: 9, originEntryId: 'a' };
const match = {
  id: 3,
  competitionId: 9,
  player1: 'MARTIN Léa',
  player2: 'DURAND Zoé',
  round: 'T32',
  startsAt: future,
  strip: 'Bleue',
};
const pool = { id: 4, competitionId: 9, name: 'Poule 7', startsAt: future, fencers: [{ name: 'MARTIN Léa', wins: 0 }] };
function setup(prefs = { fencerSchedule: true, newMatches: false, reminders: false, recap: false }) {
  const rows = new Map(),
    updates = [],
    sent = [];
  const sub = {
    id: 's',
    userId: 7,
    enabled: true,
    preferences: prefs,
    tournamentIds: [],
    competitionIds: [],
    createdAt: new Date(now),
  };
  const tx = {
    $queryRaw: async () => [],
    followedFencer: { findMany: async () => [favorite] },
    competition: { findUnique: async () => null },
    pushSubscription: { findUnique: async () => sub },
    match: { findUnique: async () => match },
    pool: { findUnique: async () => pool },
    pushDelivery: {
      upsert: async ({ create }) => {
        const key = `${create.kind}:${create.round}`;
        if (!rows.has(key)) rows.set(key, create);
      },
      updateMany: async ({ data }) => updates.push(data.status),
    },
  };
  return {
    tx,
    db: { $transaction: async (fn) => fn(tx) },
    sub,
    rows,
    updates,
    sent,
    sender: async (...args) => sent.push(args),
    context: [{ competition: c, matches: [match], pools: [pool], rounds: [] }],
  };
}
test('schedules are opt-in, boolean validated, old settings stay off', () => {
  assert.equal(preferences({}).fencerSchedule, false);
  assert.equal(preferences({ v: 2, fencerResults: true }).fencerSchedule, false);
  assert.equal(preferences({ fencerSchedule: true }).fencerSchedule, true);
  assert.throws(() => preferences({ fencerSchedule: 'yes' }), /invalide/);
});
test('only actual upcoming matches and unstarted confirmed pools are eligible', () => {
  assert.equal(upcomingMatch(match, now), true);
  for (const extra of [
    { isFinished: true },
    { liveDetectedAt: new Date() },
    { syncIssue: 'ambiguous' },
    { resultType: 'CANCELLED' },
    { startsAt: new Date(now - 1) },
    { player2: 'Vainqueur T64' },
    { player2: 'Exempt' },
  ])
    assert.equal(upcomingMatch({ ...match, ...extra }, now), false);
  assert.equal(upcomingPool(pool, now), true);
  for (const extra of [
    { isLocked: true },
    { isFinal: true },
    { lockMode: 'PROVISIONAL' },
    { startsAt: new Date(now - 1) },
    { fencers: [{ firstResultAt: new Date() }] },
  ])
    assert.equal(upcomingPool({ ...pool, ...extra }, now), false);
});
test('schedule wording uses actual startsAt and timezone, never prediction deadline', () => {
  const row = { ...match, startsAt: '2026-10-24T12:30:00Z', closesAt: '2026-10-24T12:20:00Z' };
  assert.match(
    scheduleText(c, row, ['MARTIN Léa'], 'Europe/Paris').body,
    /MARTIN Léa – DURAND Zoé · T32 · Piste Bleue · 24\/10.*14:30/,
  );
  assert.match(
    scheduleText(c, { ...pool, startsAt: null }, ['MARTIN Léa'], 'Europe/Paris', true).body,
    /MARTIN Léa · Poule 7 · piste à confirmer · heure à confirmer/,
  );
});
test('queue is per encounter or pool, idempotent across schedule refreshes', async () => {
  const s = setup();
  await queueSchedules(s.tx, s.sub, s.context, now);
  await queueSchedules(s.tx, s.sub, s.context, now);
  assert.equal(s.rows.size, 2);
  assert.deepEqual(
    [...s.rows.values()].map((r) => r.matchIds),
    [[3], [4]],
  );
  s.context[0].matches = [{ ...match, player1: 'OTHER', player2: 'OTHER2' }];
  s.context[0].pools = [];
  s.rows.clear();
  await queueSchedules(s.tx, s.sub, s.context, now);
  assert.equal(s.rows.size, 0);
});
test('worker queue respects opt-in, event scope and quiet hours without any prediction queries', async () => {
  let s = setup();
  await push.queueSpecial(s.db, 's', s.context);
  assert.equal(s.rows.size, 2);
  for (const prefs of [
    { fencerSchedule: false },
    { fencerSchedule: true, followAll: false },
    { fencerSchedule: true, quietEnabled: true, quietStart: '00:00', quietEnd: '23:59', timezone: 'UTC' },
  ]) {
    s = setup({ newMatches: false, reminders: false, recap: false, ...prefs });
    await push.queueSpecial(s.db, 's', s.context);
    assert.equal(s.rows.size, 0);
  }
});
test('delivery rechecks favorites and option, cancels obsolete schedule, high priority and no writes to matches', async () => {
  const s = setup();
  const d = { id: 'd', kind: 'FENCER_MATCH_SCHEDULE', matchIds: [3], createdAt: new Date(), attempts: 0 };
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0][3], 'high');
  assert.equal(s.sent[0][1].url, '/direct/1/9');
  s.sub.preferences.fencerSchedule = false;
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  s.sub.preferences.fencerSchedule = true;
  s.tx.match.findUnique = async () => ({ ...match, isFinished: true });
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  s.tx.match.findUnique = async () => match;
  s.tx.followedFencer.findMany = async () => [];
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.updates, ['SENT', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
});
test('pool delivery names the pool and reads latest schedule', async () => {
  const s = setup();
  await push.deliverSpecial(
    s.tx,
    { id: 'd', kind: 'FENCER_POOL_SCHEDULE', matchIds: [4], createdAt: new Date(), attempts: 0 },
    s.sub,
    c,
    [],
    s.sender,
  );
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0][1].body, /Poule 7/);
  assert.equal(s.sent[0][3], 'high');
});

test('two favorites in one encounter produce one alert and a true club homonym stays excluded', async () => {
  const s = setup();
  const second = { id: 2, name: 'DURAND Zoé', country: 'ITA', originCompetitionId: 9, originEntryId: 'b' };
  s.tx.followedFencer.findMany = async () => [favorite, second];
  s.context[0].competition = {
    ...c,
    podiumRoster: [...c.podiumRoster, { id: 'b', name: second.name, country: 'ITA' }],
  };
  s.context[0].pools = [];
  await queueSchedules(s.tx, s.sub, s.context, now);
  assert.equal(s.rows.size, 1);
  s.rows.clear();
  s.tx.followedFencer.findMany = async () => [
    { id: 1, name: 'MARTIN Léa', club: 'CLUB A', originCompetitionId: 9, originEntryId: 'a' },
  ];
  s.context[0].competition = {
    ...c,
    podiumRoster: [
      { id: 'a', name: 'MARTIN Léa', country: 'CLUB A' },
      { id: 'b', name: 'MARTIN Léa', country: 'CLUB B' },
    ],
  };
  s.context[0].matches = [{ ...match, club1: 'CLUB B' }];
  await queueSchedules(s.tx, s.sub, s.context, now);
  assert.equal(s.rows.size, 0);
  s.context[0].matches[0].club1 = 'CLUB A';
  await queueSchedules(s.tx, s.sub, s.context, now);
  assert.equal(s.rows.size, 1);
});

test('delivery uses latest schedule and cancels expired, foreign-event and quiet-hour alerts', async () => {
  const s = setup();
  const d = { id: 'd', kind: 'FENCER_MATCH_SCHEDULE', matchIds: [3], createdAt: new Date(), attempts: 0 };
  s.tx.match.findUnique = async () => ({ ...match, strip: 'Piste 12' });
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  assert.match(s.sent[0][1].body, /Piste 12/);
  await push.deliverSpecial(s.tx, { ...d, createdAt: new Date(now - 2 * 86400000) }, s.sub, c, [], s.sender);
  s.tx.match.findUnique = async () => ({ ...match, competitionId: 99 });
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  const hour = new Date().getUTCHours();
  s.sub.preferences = {
    ...s.sub.preferences,
    quietEnabled: true,
    timezone: 'UTC',
    quietStart: `${String(hour).padStart(2, '0')}:00`,
    quietEnd: `${String((hour + 1) % 24).padStart(2, '0')}:00`,
  };
  await push.deliverSpecial(s.tx, d, s.sub, c, [], s.sender);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.updates, ['SENT', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
});
