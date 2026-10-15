const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enabled } = require('../src/services/stagingLiveDemo');
test('la simulation refuse toute autre base, service ou activation de FTL/envoi', () => {
  const keys = [
    'RENDER_SERVICE_ID',
    'DATABASE_URL',
    'FTL_AUTO_SYNC',
    'FTL_LIVE_SCORES',
    'CALENDAR_WATCH',
    'RESEND_API_KEY',
    'VAPID_PRIVATE_KEY',
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, {
      RENDER_SERVICE_ID: 'srv-db7911tg1s2s739j99og',
      DATABASE_URL: 'postgresql://test:test@ep-tiny-mouse-b1lipgr7-pooler.c-5.eu-central-1.aws.neon.tech/neondb',
      FTL_AUTO_SYNC: 'false',
      FTL_LIVE_SCORES: 'false',
      CALENDAR_WATCH: 'false',
    });
    delete process.env.RESEND_API_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    assert.equal(enabled(), true);
    for (const [key, value] of [
      ['RENDER_SERVICE_ID', 'production'],
      ['DATABASE_URL', 'postgresql://test:test@production.invalid/neondb'],
      ['FTL_AUTO_SYNC', 'true'],
      ['FTL_LIVE_SCORES', 'true'],
      ['CALENDAR_WATCH', 'true'],
      ['RESEND_API_KEY', 'test'],
      ['VAPID_PRIVATE_KEY', 'test'],
    ]) {
      const old = process.env[key];
      process.env[key] = value;
      assert.equal(enabled(), false, key);
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  } finally {
    for (const k of keys)
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
  }
});
