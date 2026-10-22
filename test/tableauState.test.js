const test = require('node:test');
const assert = require('node:assert/strict');
const { tableauState } = require('../src/services/tableauState');
test('exempts nouvellement importés et corrigés : lecture légère, sans aucune écriture', async () => {
  let byes = null;
  const db = {
    competition: {
      findUnique: async (query) => {
        assert.deepEqual(query, { where: { id: 41 }, select: { id: true, tableauByes: true } });
        return { id: 41, tableauByes: byes };
      },
    },
  };
  assert.deepEqual(await tableauState(db, 41), { competitionId: 41, byes: [] });
  byes = Array.from({ length: 15 }, (_, i) => ({ round: 'T64', pos: i + 1, name: `Synthetic ${i}` }));
  assert.deepEqual((await tableauState(db, 41)).byes, byes);
  byes = [];
  assert.deepEqual((await tableauState(db, 41)).byes, []);
  db.competition.findUnique = async () => null;
  assert.equal(await tableauState(db, 41), null);
  db.competition.findUnique = async () => {
    throw new Error('unavailable');
  };
  await assert.rejects(tableauState(db, 41), /unavailable/);
});
