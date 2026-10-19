const test = require('node:test');
const assert = require('node:assert/strict');
const { measure } = require('../scripts/measureLiveBandwidth.cjs');
test('SSE gzip et identité : mêmes scores/lampes/touches/corrections, flux différentiel et ancien écran', async () => {
  for (const delta of [false, true]) {
    const identity = await measure({ delta, updates: 10 });
    const gzip = await measure({ delta, gzip: true, updates: 10 });
    assert.equal(gzip.frames, identity.frames);
    assert.ok(gzip.bytes < identity.bytes / 2);
  }
});
