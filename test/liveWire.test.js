const test = require('node:test');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { encodeLiveWire } = require('../src/services/liveWire');
const { measure } = require('../scripts/measureLiveBandwidth.cjs');
test('compression négociée : aucun changement sans option, petits messages intacts et Unicode fidèle', async () => {
  const body = JSON.stringify({ matches: [{ matchId: 1, label: 'Synthétique é🤺'.repeat(1000) }] });
  assert.equal(await encodeLiveWire(body, false), body);
  assert.equal(await encodeLiveWire('[]', true), '[]');
  const packed = JSON.parse(await encodeLiveWire(body, true));
  assert.equal(packed.wire, 'gzip-base64-v1');
  assert.equal(gunzipSync(Buffer.from(packed.data, 'base64')).toString(), body);
});
test('vrai HTTP à travers un relais qui retire gzip : snapshots, deltas et corrections restent compressés et identiques', async () => {
  for (const delta of [false, true]) {
    const before = await measure({ delta, gzip: true, transformProxy: true });
    const after = await measure({ delta, gzip: true, transformProxy: true, packedWire: true });
    assert.equal(after.frames, before.frames);
    assert.ok(after.bytes < before.bytes / 2);
  }
});
