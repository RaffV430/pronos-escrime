const { test } = require('node:test');
const assert = require('node:assert/strict');
const { finish } = require('../src/services/ftlScheduler');
const { syncPools } = require('../src/services/engardeSync');
const { trackingIssue } = require('../src/services/syncHealth');
test('an unreadable published pool page is incomplete, not an unpublished source', async () => {
  const result = await syncPools({}, { id: 1 }, {}, 'https://engarde-service.com/test', { get: async () => '' });
  assert.equal(result.coverageComplete, false);
  assert.equal(result.expectedPools, 0);
  assert.equal(result.checked, 0);
  assert.ok(result.warnings.length);
});
test('a confirmed podium cannot stop retries when some official pools were not imported', async () => {
  const state = { leaseToken: 'test', failures: 0 };
  const db = {
    ftlSyncState: { findUnique: async () => state, updateMany: async ({ data }) => Object.assign(state, data) },
  };
  const now = new Date('2026-10-18T12:00:00Z');
  await finish(
    db,
    1,
    'test',
    { podium: true, pools: { coverageComplete: false }, warnings: ['Import incomplet : 38/39 poules'], conflicts: [] },
    null,
    now,
  );
  assert.equal(state.status, 'ATTENTION');
  assert.ok(state.nextAutomaticAt > now);
  state.leaseToken = 'next';
  await finish(
    db,
    1,
    'next',
    { podium: true, pools: { coverageComplete: true }, warnings: [], conflicts: [] },
    null,
    now,
  );
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.nextAutomaticAt, null);
});
test('tracking diagnostics distinguish missing, stopped, future, newly created and genuinely completed events', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const c = { createdAt: new Date('2026-10-17T12:00:00Z') };
  const cfg = { date: '2026-10-18', time: '08:00', timezone: 'Europe/Paris' };
  assert.match(trackingIssue(null, c, cfg, now), /aucun suivi/);
  assert.match(trackingIssue({ status: 'READY', nextAutomaticAt: null }, c, cfg, now), /Suivi arrêté/);
  assert.match(trackingIssue({ status: 'COMPLETE' }, c, cfg, now), /sans podium/);
  assert.equal(trackingIssue(null, c, { ...cfg, date: '2026-10-19' }, now), null);
  assert.equal(trackingIssue(null, { ...c, createdAt: new Date(now - 60000) }, cfg, now), null);
  assert.equal(trackingIssue(null, { ...c, podiumResolvedAt: new Date(now) }, cfg, now), null);
  assert.equal(trackingIssue(null, c, null, now), null);
  assert.equal(trackingIssue({ status: 'RUNNING' }, c, cfg, now), null);
});
