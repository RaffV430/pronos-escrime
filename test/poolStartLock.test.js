// Épreuves en France : une poule suivie se ferme à son heure de début annoncée, le premier résultat
// restant une sécurité ; l'heure de clôture suit l'heure officielle quand elle change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/services/poolRules');
const { poolsNotification } = require('../src/services/poolRecompose');

const start = new Date('2026-10-04T07:00:00Z'); // 9 h à Paris

test('mode de clôture : heure de début en France, premier résultat sinon', () => {
  assert.deepEqual(R.sourceLock(start, true, new Date(0)), { lockMode: R.START_LOCK, closesAt: start });
  assert.equal(R.sourceLock(start, false, new Date(0)).lockMode, 'FIRST_RESULT');
  assert.equal(R.sourceLock(null, true, new Date(0)).lockMode, 'FIRST_RESULT', 'sans heure : premier résultat');
});

test('poule fermée à son heure de début, tireur fermé au premier résultat avant', () => {
  const pool = {
    lockMode: R.START_LOCK,
    closesAt: start,
    isLocked: false,
    isFinal: false,
    sourceCheckedAt: new Date(),
  };
  const before = new Date('2026-10-04T06:59:00Z'),
    after = new Date('2026-10-04T07:00:00Z');
  assert.equal(R.closed(pool, before), false);
  assert.equal(R.closed(pool, after), true);
  assert.equal(R.fencerClosed({ ...pool, sourceCheckedAt: before }, { firstResultAt: before }, before), true);
  assert.equal(R.followsSource(pool), true);
  assert.equal(R.followsSource({ lockMode: 'TIME' }), false);
});

test('notification prioritaire : poules et heure de début', () => {
  const n = poolsNotification(
    { id: 12, tournamentId: 3, name: 'Fleuret Dames senior' },
    [
      { name: 'Poule 2', startsAt: start },
      { name: 'Poule 10', startsAt: new Date('2026-10-04T09:00:00Z') },
    ],
    { urgent: true },
  );
  assert.match(n.title, /^⚠ Poules modifiées/);
  assert.match(n.body, /Poule 2 et Poule 10 ont changé, début à 09:00/);
  assert.match(
    poolsNotification({ id: 1, tournamentId: 1, name: 'x' }, [{ name: 'Poule 1' }]).title,
    /^Poules modifiées/,
  );
});

test('applyPool : la poule suit l’heure officielle (France)', async () => {
  const { applyPool } = require('../src/services/ftlPools');
  const pool = {
    id: 5,
    competitionId: 1,
    sourceUrl: 'u',
    sourcePoolNumber: 1,
    lockMode: 'FIRST_RESULT',
    isLocked: false,
    isFinal: false,
    closesAt: new Date('2026-10-04T00:00:00Z'),
    startsAt: null,
    strip: null,
    fencers: [
      { id: 1, name: 'A', position: 1 },
      { id: 2, name: 'B', position: 2 },
    ],
  };
  let saved;
  const tx = {
    $queryRaw: async () => [],
    pool: { findUnique: async () => pool, update: async ({ data }) => (saved = data) },
    poolFencer: { updateMany: async () => ({ count: 1 }) },
    poolPrediction: { findMany: async () => [] },
  };
  const rows = [
    { name: 'A', position: 1, firstResult: false, hasResult: false },
    { name: 'B', position: 2, firstResult: false, hasResult: false },
  ];
  await applyPool(
    tx,
    pool,
    { complete: false, ambiguous: false, rows, startsAt: start, closeAtStart: true },
    new Date(),
  );
  assert.equal(saved.lockMode, R.START_LOCK);
  assert.equal(saved.closesAt.getTime(), start.getTime());
  await applyPool(
    tx,
    pool,
    { complete: false, ambiguous: false, rows, startsAt: start, closeAtStart: false },
    new Date(),
  );
  assert.equal(saved.lockMode, undefined, 'hors de France : rien ne change');
});

test('tirage provisoire (engarde, avant l’appel) : poule visible mais fermée', () => {
  const E = require('../src/services/engardeParser');
  assert.equal(
    E.rosterCheckedIn(
      '<h3>Tireurs (présents - 235)</h3><table class="liste" summary="Tireurs (présents - 235)"></table>',
    ),
    true,
  );
  assert.equal(E.rosterCheckedIn('<h3>Tireuses (présentes - 37)</h3>'), true);
  assert.equal(E.rosterCheckedIn('<h3>Tireurs (inscrits - 245)</h3><table class="liste"></table>'), false);
  const lock = R.sourceLock(start, true, new Date(0), true);
  assert.equal(lock.lockMode, R.PROVISIONAL);
  const pool = { ...lock, isLocked: false, isFinal: false };
  assert.equal(R.closed(pool, new Date('2026-10-03T12:00:00Z')), true);
  assert.equal(R.followsSource(pool), true);
});
