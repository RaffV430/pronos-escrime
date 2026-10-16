const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitingForJ2 } = require('../src/services/syncHealth');
test('attente J2 uniquement après J1 terminé et avant horaire officiel', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const c = {
    pools: [{ isFinal: true }],
    matches: [
      { round: 'J1:T64', isFinished: true },
      { round: 'T64', startsAt: '2026-10-17T01:40:00Z' },
    ],
  };
  const cfg = { timezone: 'Asia/Tokyo' };
  assert.deepEqual(waitingForJ2(c, cfg, now), { startsAt: '2026-10-17T01:40:00.000Z', timezone: 'Asia/Tokyo' });
  assert.equal(waitingForJ2(c, cfg, Date.parse('2026-10-17T01:40:00Z')), null);
  assert.equal(waitingForJ2({ ...c, pools: [{ isFinal: false }] }, cfg, now), null);
  assert.equal(waitingForJ2({ ...c, matches: [{ round: 'J1:T64', isFinished: false }, c.matches[1]] }, cfg, now), null);
  assert.equal(
    waitingForJ2({ ...c, matches: [c.matches[0], { ...c.matches[1], liveDetectedAt: new Date(now) }] }, cfg, now),
    null,
  );
  assert.equal(waitingForJ2({ matches: [c.matches[0]] }, cfg, now), null);
  assert.equal(
    waitingForJ2(
      { matches: [c.matches[0]] },
      { ...cfg, scheduleSessions: [{}, { date: '2026-10-17', time: '9:00 AM' }] },
      now,
    ).startsAt,
    '2026-10-17T00:00:00.000Z',
  );
});
