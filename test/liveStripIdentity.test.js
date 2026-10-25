const { test } = require('node:test');
const assert = require('node:assert/strict');
const { liveStripIdentity } = require('../src/services/liveStripIdentity');
test('only the explicit podiom variant joins podium; other strip identities remain distinct', () => {
  assert.equal(liveStripIdentity(' PODIOM '), liveStripIdentity('podium'));
  assert.notEqual(liveStripIdentity('podium 2'), liveStripIdentity('podium'));
  assert.notEqual(liveStripIdentity('podiun'), liveStripIdentity('podium'));
  assert.notEqual(liveStripIdentity('Rouge'), liveStripIdentity('Verte'));
  assert.equal(liveStripIdentity(null), '');
});
