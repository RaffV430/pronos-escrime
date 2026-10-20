// Samsun (20/10/2026) : un tournoi déjà complet, désarchivé pour un rattrapage, était réarchivé quelques
// secondes plus tard par l'archivage automatique. Le désarchivage manuel laisse désormais 6 h.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unarchive, UNARCHIVE_GRACE_MS } = require('../src/services/tournamentArchive');

test('désarchivage manuel : prochaine vérification de fin dans 6 h, pas immédiatement', async () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const updates = [];
  const tx = {
    $queryRaw: async () => [],
    tournament: {
      findUnique: async () => ({ id: 1, archivedAt: new Date('2026-09-28T00:00:00Z'), competitions: [] }),
      update: async (args) => updates.push(args),
    },
    competition: { findMany: async () => [] },
    ftlSyncState: { findMany: async () => [], updateMany: async () => ({}), upsert: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  const db = { $transaction: (fn) => fn(tx) };
  await unarchive(db, 1, 6, now);
  assert.equal(UNARCHIVE_GRACE_MS, 6 * 3600000);
  assert.equal(updates[0].data.archivedAt, null);
  assert.equal(updates[0].data.completionNextCheckAt.toISOString(), '2026-10-20T14:00:00.000Z');
});
