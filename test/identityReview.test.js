const { test } = require('node:test');
const assert = require('node:assert/strict');
const { record, confirm } = require('../src/services/identityReview');
function fixture() {
  let c = { id: 7, podiumRoster: [{ id: 'kept', name: 'MARTIN Alex', country: 'FRA' }] };
  const audits = [];
  const tx = {
    $queryRaw: async () => [],
    competition: { findUnique: async () => c, update: async ({ data }) => (c = { ...c, ...data }) },
    auditLog: { create: async ({ data }) => audits.push(data) },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  return { db, audits, get: () => c };
}
test('records official contradiction without modifying roster or predictions; repeated observation is stable', async () => {
  const f = fixture();
  const observed = [{ id: 'new', name: 'MARTIN Alex', country: 'ITA' }];
  await record(f.db, f.get(), 'https://engarde-service.com/competition/a/b/c/tireurs.htm', observed);
  const version = f.get().identityReview.version;
  await record(f.db, f.get(), 'https://engarde-service.com/competition/a/b/c/tireurs.htm', observed);
  assert.equal(f.get().identityReview.version, version);
  assert.equal(f.get().podiumRoster[0].country, 'FRA');
  await confirm(f.db, 7, version, 'Nation corrigée sur la liste officielle', 42);
  assert.equal(f.get().podiumRoster[0].id, 'kept');
  assert.equal(f.get().podiumRoster[0].country, 'ITA');
  assert.equal(f.audits[0].actorId, 42);
  await assert.rejects(confirm(f.db, 7, version, 'Nouvelle confirmation interdite', 42), { status: 409 });
});
test('stale review and short reason cannot change identities', async () => {
  const f = fixture();
  await record(f.db, f.get(), 'https://engarde-service.com/competition/a/b/c/tireurs.htm', [
    { id: 'new', name: 'MARTIN Alex', country: 'ITA' },
  ]);
  const version = f.get().identityReview.version;
  await assert.rejects(confirm(f.db, 7, version, 'oui', 42), { status: 400 });
  f.get().podiumRoster[0].country = 'DEU';
  await assert.rejects(confirm(f.db, 7, version, 'Je confirme après vérification', 42), { status: 409 });
  assert.equal(f.audits.length, 0);
});
