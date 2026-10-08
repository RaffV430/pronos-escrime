const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finish, INTERVAL } = require('../src/services/ftlScheduler');
const { freshness } = require('../src/services/playerExperience');

function fakeDb() {
  const state = { competitionId: 1, leaseToken: 't', failures: 0 };
  return {
    state,
    ftlSyncState: {
      findUnique: async () => state,
      updateMany: async ({ data }) => Object.assign(state, data),
    },
  };
}
const now = new Date('2026-10-10T10:00:00Z');

test('an unpublished bracket on event day is information, not an issue: normal 2-min pace', async () => {
  const db = fakeDb();
  const notes = ['Tableau pas encore publié. Il sera recherché au prochain contrôle.'];
  await finish(db, 1, 't', { warnings: [], notes, eventDate: '2026-10-10' }, null, now);
  assert.equal(db.state.status, 'READY');
  assert.equal(db.state.nextAutomaticAt.getTime() - now.getTime(), INTERVAL);
  assert.equal(freshness(db.state, now.getTime()).state, 'CURRENT');
});

test('a real warning still flags the follow-up and slows to 5 min', async () => {
  const db = fakeDb();
  await finish(db, 1, 't', { warnings: ['Poule 2 : score réciproque manquant'], eventDate: '2026-10-10' }, null, now);
  assert.equal(db.state.status, 'ATTENTION');
  assert.equal(db.state.nextAutomaticAt.getTime() - now.getTime(), 5 * 60000);
  assert.equal(freshness(db.state, now.getTime()).state, 'DELAYED');
});

test('event start follows the venue time zone, with a safe fallback', () => {
  const { eventStart } = require('../src/services/eventStart');
  assert.equal(
    new Date(eventStart({ date: '2026-10-10', timezone: 'Europe/Paris' })).toISOString(),
    '2026-10-09T22:00:00.000Z',
  );
  assert.equal(
    new Date(eventStart({ date: '2026-10-10', timezone: 'America/New_York' })).toISOString(),
    '2026-10-10T04:00:00.000Z',
  );
  assert.equal(new Date(eventStart({ date: '2026-10-10' })).toISOString(), '2026-10-09T10:00:00.000Z');
  assert.equal(eventStart({ date: 'bad' }), null);
});

test('pace: 15 min before the start (last check 1 min before), then 2 min while pools are open, even with warnings', async () => {
  const eventStart = '2026-10-09T22:00:00.000Z';
  const pace = async (at, summary) => {
    const db = fakeDb();
    const when = new Date(at);
    await finish(db, 1, 't', { warnings: [], eventDate: '2026-10-10', eventStart, ...summary }, null, when);
    return (db.state.nextAutomaticAt - when) / 60000;
  };
  assert.equal(await pace('2026-10-09T21:00:00Z', { openFirstResultPools: 3 }), 15);
  assert.equal(await pace('2026-10-09T21:50:00Z', { openFirstResultPools: 3 }), 9);
  assert.equal(await pace('2026-10-10T08:00:00Z', { openFirstResultPools: 3, warnings: ['x'] }), 0.5);
  assert.equal(await pace('2026-10-10T08:00:00Z', { openFirstResultPools: 0, warnings: ['x'] }), 5);
});

test('active phases use 30 seconds for pools and 10 seconds for published tableaux', async () => {
  for (const [syncPhase, delay] of [
    ['POOLS', 30000],
    ['TABLEAU', 10000],
  ]) {
    const db = fakeDb();
    await finish(db, 1, 't', { syncPhase, eventStart: '2026-10-10T08:00:00Z', warnings: [] }, null, now);
    assert.equal(db.state.nextAutomaticAt - now, delay);
  }
});
test('fast tableau polling retains failure backoff and completion stop', async () => {
  const db = fakeDb();
  await finish(db, 1, 't', { syncPhase: 'TABLEAU' }, 'Source unavailable', now);
  assert.equal(db.state.nextAutomaticAt - now, 120000);
  db.state.leaseToken = 't';
  await finish(db, 1, 't', { syncPhase: 'TABLEAU', podium: true }, null, now);
  assert.equal(db.state.nextAutomaticAt, null);
});
