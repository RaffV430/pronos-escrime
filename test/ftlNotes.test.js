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
