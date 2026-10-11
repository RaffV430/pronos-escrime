const test = require('node:test');
const assert = require('node:assert/strict');
const { ingestObserved, _ingested } = require('../src/services/fencerAffiliations');

function db({ fail = false } = {}) {
  const calls = { tx: 0 };
  return {
    calls,
    fencerAffiliation: {},
    $transaction: async (fn, options) => {
      calls.tx++;
      calls.options = options;
      if (fail) throw new Error('timeout');
      return fn({});
    },
  };
}
const c = { id: 777, podiumFormat: 'INDIVIDUAL' };
const roster = [{ id: 1, name: 'MARTIN Léa', country: 'FRA', club: 'CEM' }];

test('club ingest runs once per roster and never blocks the sync', async () => {
  _ingested.clear();
  const ok = db();
  // ingest() itself is skipped by the empty transaction client (no fencerAffiliation model inside).
  assert.equal(await ingestObserved(ok, c, roster, 'https://x/1', 0), true);
  assert.equal(await ingestObserved(ok, c, roster, 'https://x/1', 1000), false);
  assert.equal(ok.calls.tx, 1);
  assert.equal(ok.calls.options.timeout, 30000);
  assert.equal(
    await ingestObserved(ok, c, [...roster, { id: 2, name: 'DURAND Chloé', country: 'FRA' }], 'https://x/1', 2000),
    true,
  );
  assert.equal(await ingestObserved(ok, c, roster, 'https://x/1', 2000 + 7 * 3600000), true);
  const broken = db({ fail: true });
  _ingested.clear();
  assert.equal(await ingestObserved(broken, c, roster, 'https://x/1', 0), false);
  assert.equal(await ingestObserved(broken, c, roster, 'https://x/1', 10), false);
  assert.equal(broken.calls.tx, 2);
});
