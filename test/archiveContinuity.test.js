const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverAddedEvents } = require('../src/services/tournamentArchive');
function fixture() {
  const archivedAt = new Date('2026-10-17T17:00:00Z');
  const completed = {
    id: 1,
    createdAt: new Date('2026-10-16'),
    podiumResolvedAt: archivedAt,
    resultsVerifiedAt: archivedAt,
    officialPodium: { finalConfirmed: true },
    pools: [],
    matches: [],
    matchRounds: [],
  };
  const tournament = {
    id: 10,
    archivedAt,
    ftlSourceUrl: 'https://engarde-service.com/tournament/test/event',
    competitions: [
      completed,
      {
        id: 2,
        createdAt: new Date('2026-10-17T18:00:00Z'),
        ftlEventId: 'ENGARDE:test/event/m20',
        pools: [],
        matches: [],
        matchRounds: [],
      },
    ],
  };
  const audit = [
    {
      action: 'Tournoi archivé après vérification officielle',
      after: {
        checkedAt: archivedAt.toISOString(),
        sourceUrl: tournament.ftlSourceUrl,
      },
    },
  ];
  const states = [{ competitionId: 1, status: 'COMPLETE', nextAutomaticAt: null }];
  const config = { provider: 'engarde', org: 'test', tournamentSlug: 'event', compe: 'm20' };
  const db = {
    $queryRaw: async () => [],
    tournament: {
      findMany: async () => [tournament],
      findUnique: async () => tournament,
      update: async ({ data }) => Object.assign(tournament, data),
    },
    auditLog: {
      findFirst: async ({ where }) => (where.action === 'Configuration FTL validée' ? { after: config } : audit.at(-1)),
      create: async ({ data }) => audit.push(data),
    },
    ftlSyncState: {
      findUnique: async ({ where }) => states.find((s) => s.competitionId === where.competitionId),
      upsert: async ({ where, create, update }) => {
        const s = states.find((s) => s.competitionId === where.competitionId);
        if (s) return Object.assign(s, update);
        states.push(create);
        return create;
      },
    },
  };
  db.$transaction = (fn) => fn(db);
  return { db, tournament, audit, states, config };
}
test('new configured category resumes only automatic archive and creates missing state, idempotently', async () => {
  const f = fixture(),
    now = new Date('2026-10-18T12:00:00Z');
  const history = structuredClone(f.tournament.competitions);
  const completed = structuredClone(f.states[0]);
  assert.deepEqual(await recoverAddedEvents(f.db, now), [10]);
  assert.equal(f.tournament.archivedAt, null);
  assert.deepEqual(f.states[0], completed);
  assert.equal(f.states[1].competitionId, 2);
  assert.equal(+f.states[1].nextAutomaticAt, +now);
  assert.deepEqual(f.tournament.competitions, history);
  assert.deepEqual(await recoverAddedEvents(f.db, now), []);
  assert.equal(f.audit.length, 2);
});
test('manual archive, changed source, missing config and pre-existing incomplete categories are never reopened', async () => {
  for (const change of [
    (f) => {
      f.audit[0].action = 'Tournoi archivé manuellement';
    },
    (f) => {
      f.config.tournamentSlug = 'other';
    },
    (f) => {
      f.config.provider = 'unknown';
    },
    (f) => {
      f.tournament.competitions[1].createdAt = new Date('2026-10-16');
    },
    (f) => {
      f.audit[0].after.checkedAt = '2026-10-17T16:00:00Z';
    },
  ]) {
    const f = fixture();
    change(f);
    assert.deepEqual(await recoverAddedEvents(f.db), []);
    assert.ok(f.tournament.archivedAt);
    assert.equal(f.states.length, 1);
  }
});
