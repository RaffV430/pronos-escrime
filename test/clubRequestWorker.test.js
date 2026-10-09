const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startWorker, wake } = require('../src/services/clubRequestMail');
const turn = () => new Promise((resolve) => setImmediate(resolve));
function timerFixture() {
  let interval;
  return {
    setInterval(fn, ms) {
      assert.equal(ms, 60000);
      interval = fn;
      return { unref() {} };
    },
    clearInterval() {},
    periodic() {
      interval();
    },
  };
}
test('committed requests wake an idle worker without waiting for its recovery timer', async () => {
  const db = {},
    timer = timerFixture();
  let queued = 0,
    sends = 0;
  const stop = startWorker(db, {
    ...timer,
    alertAdmins: async () => {
      if (!queued) return 0;
      queued--;
      sends++;
      return 1;
    },
    deliver: async () => 0,
  });
  await turn();
  queued = 3;
  assert.equal(wake(db), true);
  await turn();
  assert.equal(sends, 3);
  await stop();
  assert.equal(wake(db), false);
});
test('a wake during delivery is retained and processing remains sequential', async () => {
  const db = {},
    timer = timerFixture();
  let release,
    passes = 0,
    active = 0,
    maxActive = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stop = startWorker(db, {
    ...timer,
    alertAdmins: async () => {
      passes++;
      active++;
      maxActive = Math.max(active, maxActive);
      if (passes === 1) await gate;
      active--;
      return 0;
    },
    deliver: async () => 0,
  });
  await turn();
  wake(db);
  wake(db);
  release();
  await turn();
  assert.equal(passes, 2);
  assert.equal(maxActive, 1);
  await stop();
});
test('provider failure leaves timer recovery available without a tight retry loop', async () => {
  const db = {},
    timer = timerFixture();
  let passes = 0;
  const stop = startWorker(db, {
    ...timer,
    alertAdmins: async () => {
      passes++;
      throw new Error('offline');
    },
    deliver: async () => assert.fail('alert failed'),
  });
  await turn();
  assert.equal(passes, 1);
  timer.periodic();
  await turn();
  assert.equal(passes, 2);
  await stop();
});
test('preview without a started worker cannot trigger outbound delivery', () => {
  assert.equal(wake({}), false);
});
