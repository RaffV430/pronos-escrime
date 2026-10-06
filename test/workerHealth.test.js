const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workerHealth, startWatchdog } = require('../src/services/workerHealth');
test('worker health has startup grace, ignores disabled workers and detects missing beats', () => {
  const opts = { now: 1000000, uptime: 121, enabled: { ftl: true, push: false }, beat: () => null };
  assert.equal(workerHealth(opts).ftl.stale, true);
  assert.equal(workerHealth(opts).push.stale, false);
  assert.equal(workerHealth({ ...opts, uptime: 100 }).ftl.stale, false);
  assert.equal(workerHealth({ ...opts, beat: () => 999999 }).ftl.stale, false);
});
test('watchdog alerts once per outage and alerts again only after recovery', async () => {
  let stale = true,
    count = 0;
  const stop = startWatchdog({
    inspect: () => ({ ftl: { stale } }),
    report: () => {
      count++;
    },
    every: 5,
  });
  try {
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(count, 1);
    stale = false;
    await new Promise((r) => setTimeout(r, 20));
    stale = true;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(count, 2);
  } finally {
    stop();
  }
});
