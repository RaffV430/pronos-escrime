const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchClosed, podiumClosed, closesAt } = require('../src/lib/matchLock');
const start = Date.parse('2026-09-26T10:00:00Z');
const m = { startsAt: new Date(start), round: 'T128', sourceUrl: 'official', sourceCheckedAt: null };
test('deadline is exactly scheduled start +30min, independent of stale source', () => {
  assert.equal(closesAt(m), '2026-09-26T10:30:00.000Z');
  assert.equal(matchClosed(m, start + 1799999), false);
  assert.equal(matchClosed(m, start + 1800000), true);
  assert.equal(matchClosed({ startsAt: null }, start), false);
});
test('manual reopening survives elapsed deadline, but never reopens a final', () => {
  assert.equal(matchClosed({ ...m, manualUnlock: true, isLocked: true }, start + 3600000), false);
  assert.equal(matchClosed({ ...m, manualUnlock: true, isFinished: true }, start), true);
});
test('podium ignores pools and later rounds, then closes with first round', () => {
  assert.equal(podiumClosed({}, [], start), false);
  assert.equal(podiumClosed({}, [m, { round: 'T64', isLocked: true }], start), false);
  assert.equal(podiumClosed({}, [m], start + 1800000), true);
  assert.equal(podiumClosed({ isPodiumLocked: true, podiumManualUnlock: true }, [m], start + 1800000), false);
});
