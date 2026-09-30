const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plannedRenames, reconcileRenames } = require('../src/services/ftlRenames');

const ID = 'E3577BC172D545149EFA8E83481A9DE2';
const OTHER = '8B75EFC878CC4876AEA1BC3359FC93E8';
const roster = [
  { id: OTHER, name: 'BERTINI IRENE', country: 'ITA', active: true, entryRanking: 44 },
  { id: ID, name: 'MARCENA LAU MARCENA LAU', country: 'CAN', active: true, entryRanking: null },
];
const official = (name, country = 'CAN') => [
  { id: OTHER, name: 'BERTINI IRENE', country: 'ITA', status: 'Checked In', rank: 44 },
  { id: ID, name, country, status: 'Checked In', rank: null },
];

test('renommage FTL : même identifiant et même nation, nouveau nom', () => {
  assert.deepEqual(
    plannedRenames(
      roster,
      [...official('LAU MARCENA')].map((r) => ({ ...r })),
    ),
    [{ id: ID, from: 'MARCENA LAU MARCENA LAU', to: 'LAU MARCENA' }],
  );
  assert.deepEqual(plannedRenames(roster, official('MARCENA LAU MARCENA LAU')), []);
  assert.deepEqual(plannedRenames(roster, official('LAU MARCENA', 'USA')), [], 'autre nation : pas de renommage');
  assert.deepEqual(plannedRenames(roster, official('BERTINI IRENE')), [], 'nom déjà porté par une autre engagée');
});

test('renommage FTL appliqué à la liste, aux poules et aux rencontres, avec trace', async () => {
  const calls = [];
  let stored = roster;
  const tx = {
    $queryRaw: async () => [],
    competition: {
      findUnique: async () => ({ id: 10, podiumRoster: stored }),
      update: async ({ data }) => {
        stored = data.podiumRoster;
        return { id: 10, podiumRoster: stored };
      },
    },
    poolFencer: { updateMany: async (a) => calls.push(['pool', a]) },
    match: { updateMany: async (a) => calls.push(['match', a]) },
    auditLog: { create: async (a) => calls.push(['audit', a]) },
  };
  const db = { $transaction: (fn) => fn(tx) };
  const client = {
    get: async (u) => {
      assert.equal(u, `/events/competitors/data/DBC27EA39C4D4DE3A5CB5ED969B88AA4`);
      return official('LAU MARCENA');
    },
  };
  const out = await reconcileRenames(db, { id: 10, podiumRoster: roster }, 'DBC27EA39C4D4DE3A5CB5ED969B88AA4', client);
  assert.equal(out.renames.length, 1);
  assert.equal(out.c.podiumRoster.find((e) => e.id === ID).name, 'LAU MARCENA');
  assert.equal(out.c.podiumRoster.find((e) => e.id === ID).entryRanking, null);
  const pool = calls.find((c) => c[0] === 'pool')[1];
  assert.deepEqual(pool.data, { name: 'LAU MARCENA' });
  assert.equal(pool.where.name, 'MARCENA LAU MARCENA LAU');
  assert.equal(calls.filter((c) => c[0] === 'match').length, 2);
  assert.equal(calls.filter((c) => c[0] === 'audit').length, 1);

  // Rien à faire au contrôle suivant.
  const again = await reconcileRenames(db, out.c, 'DBC27EA39C4D4DE3A5CB5ED969B88AA4', client);
  assert.deepEqual(again.renames, []);
});
