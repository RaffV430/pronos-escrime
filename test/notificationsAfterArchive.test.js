// Hénin-Beaumont (18/10/2026) : tournoi archivé juste après la vérification officielle,
// le récap de fin d'épreuve n'est jamais parti. Les alertes restent possibles 24 h après l'archivage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const push = require('../src/services/pushNotifications');

const NOW = Date.parse('2026-10-18T15:00:00Z');
const tournaments = [
  { id: 1, archivedAt: null },
  { id: 2, archivedAt: new Date('2026-10-18T14:45:00Z') }, // archivé il y a 15 min
  { id: 3, archivedAt: new Date('2026-10-17T14:00:00Z') }, // archivé il y a plus de 24 h
];
// Base factice : applique le filtre demandé sur le tournoi de chaque épreuve.
function fakeDb() {
  const keep = (where, t) =>
    where.OR.some((c) =>
      c.archivedAt === null ? t.archivedAt === null : t.archivedAt && t.archivedAt >= c.archivedAt.gte,
    );
  const competitions = tournaments.map((t) => ({ id: t.id * 10, tournamentId: t.id }));
  return {
    competition: {
      findMany: async ({ where }) =>
        competitions.filter((c) =>
          keep(
            where.tournament,
            tournaments.find((t) => t.id === c.tournamentId),
          ),
        ),
    },
    match: { findMany: async () => [] },
    matchRound: { findMany: async () => [] },
    pool: { findMany: async () => [] },
    auditLog: { findMany: async () => [] },
  };
}

test('un tournoi archivé depuis moins de 24 h reste dans les notifications, pas au-delà', async () => {
  const context = await push.notificationContext(fakeDb(), NOW);
  assert.deepEqual(
    context.map((x) => x.competition.id),
    [10, 20],
  );
  assert.equal(push.ARCHIVE_GRACE_MS, 24 * 3600000);
});

test('le filtre accepte les tournois actifs et ceux archivés dans le délai', () => {
  const where = push.notifiedTournaments(NOW);
  assert.deepEqual(where.OR[0], { archivedAt: null });
  assert.equal(where.OR[1].archivedAt.gte.toISOString(), '2026-10-17T15:00:00.000Z');
});
