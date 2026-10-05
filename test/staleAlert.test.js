// Alerte « site officiel figé » : seuils larges, pas la nuit, pas quand une phase est annoncée plus tard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { alertStale, STALE_ACTION } = require('../src/services/syncHealth');

function fakeDb({ lastResult = null, lastPool = null, next = null, tableauStarted = 0 } = {}) {
  const audit = [];
  return {
    audit,
    match: {
      aggregate: async () => ({ _max: { resultRegisteredAt: lastResult } }),
      findFirst: async () => (next ? { startsAt: next } : null),
      count: async () => tableauStarted,
    },
    poolFencer: { aggregate: async () => ({ _max: { firstResultAt: lastPool } }) },
    pool: { findFirst: async () => null },
    auditLog: {
      findFirst: async () => audit.filter((a) => a.action === STALE_ACTION).at(-1) || null,
      create: async ({ data }) => (audit.push({ id: audit.length + 1, ...data }), audit.at(-1)),
      update: async () => {},
    },
    competition: { findUnique: async () => ({ name: 'Fleuret Dames', tournamentId: 1 }) },
    user: { findMany: async () => [] },
    pushSubscription: { findMany: async () => [] },
  };
}
const deps = (now) => ({
  now: new Date(now),
  mailer: { mailConfigured: () => false },
  push: { configured: () => false },
});
const start = '2026-10-11T07:00:00Z'; // 9 h à Paris

test('poules : 2 h sans résultat = normal, 2 h 30 = alerte, une seule fois', async () => {
  const db = fakeDb({ lastPool: new Date('2026-10-11T08:00:00Z') });
  const at = (iso) => alertStale(db, { competitionId: 1, eventStart: start }, deps(iso));
  assert.equal(await at('2026-10-11T10:00:00Z'), null);
  const alert = await at('2026-10-11T10:31:00Z');
  assert.equal(alert?.kind, 'stale');
  assert.equal(await at('2026-10-11T11:00:00Z'), null, 'pas de répétition pour la même période de silence');
});

test('tableau : seuil 1 h 45 ; phase annoncée plus tard ou nuit : pas d’alerte', async () => {
  const last = new Date('2026-10-11T12:00:00Z');
  assert.equal(
    (
      await alertStale(
        fakeDb({ lastResult: last, tableauStarted: 3 }),
        { competitionId: 1, eventStart: start },
        deps('2026-10-11T13:50:00Z'),
      )
    )?.kind,
    'stale',
  );
  assert.equal(
    await alertStale(
      fakeDb({ lastResult: last, tableauStarted: 3, next: new Date('2026-10-11T15:00:00Z') }),
      { competitionId: 1, eventStart: start },
      deps('2026-10-11T13:50:00Z'),
    ),
    null,
  );
  assert.equal(
    await alertStale(
      fakeDb({ lastResult: last, tableauStarted: 3 }),
      { competitionId: 1, eventStart: start },
      deps('2026-10-11T21:30:00Z'),
    ),
    null,
    '23 h 30 à Paris',
  );
  assert.equal(
    await alertStale(
      fakeDb({ lastResult: last }),
      { competitionId: 1, eventStart: start, complete: true },
      deps('2026-10-11T18:00:00Z'),
    ),
    null,
  );
});
