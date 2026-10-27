// Mode veille des tâches de fond : rythme rapide en compétition, grille commune de 15 min sinon, pour que la
// base Neon puisse s'endormir.
const test = require('node:test');
const assert = require('node:assert/strict');
const idle = require('../src/lib/idleClock');
const { nextDelay } = require('../src/services/ftlScheduler');
const { inPlay, nextDispatchDelay } = require('../src/services/pushNotifications');
const { workerHealth } = require('../src/services/workerHealth');

const T = Date.parse('2026-10-26T02:07:30Z');
const H = 3600e3;

test('grille commune : créneaux de 15 min alignés, décalage par tâche', () => {
  assert.equal(idle.untilSlot(0, T), Date.parse('2026-10-26T02:15:00Z') - T);
  assert.equal(idle.untilSlot(10000, T), Date.parse('2026-10-26T02:15:10Z') - T);
  assert.equal(idle.untilSlot(0, Date.parse('2026-10-26T02:15:00Z')), 15 * 60000, 'juste sur un créneau : le suivant');
  process.env.BACKGROUND_IDLE_MS = '60000';
  assert.equal(idle.idlePeriod(), idle.DEFAULT_IDLE_MS, 'moins de 6 min refusé : Neon ne dormirait jamais');
  delete process.env.BACKGROUND_IDLE_MS;
});

test('suivi FTL : 5 s en contrôle, sinon prochaine échéance plafonnée au créneau de veille', () => {
  assert.equal(nextDelay(T, { busy: true, nextAt: null }), 5000);
  assert.equal(nextDelay(T, { busy: false, nextAt: T + 2 * 60000 }), 2 * 60000, 'échéance dans 2 min');
  assert.equal(nextDelay(T, { busy: false, nextAt: T + 2 * H }), idle.untilSlot(0, T), 'échéance lointaine');
  assert.equal(nextDelay(T, { busy: false, nextAt: T - 1000 }), 5000, 'échéance dépassée : tout de suite');
  process.env.BACKGROUND_IDLE = 'false';
  assert.equal(nextDelay(T, { busy: false, nextAt: null }), 5000, 'veille désactivée : ancien rythme');
  delete process.env.BACKGROUND_IDLE;
});

test('notifications : en jeu = 30 s ; nuit sans épreuve = veille', () => {
  const iso = (ms) => new Date(T + ms).toISOString();
  const ctx = (extra) => [{ competition: {}, matches: [], pools: [], reopened: [], ...extra }];
  const now = T;
  assert.equal(inPlay(ctx({}), now), false);
  assert.equal(inPlay(ctx({ matches: [{ isFinished: false, startsAt: iso(3 * H) }] }), now), true, 'match dans 3 h');
  assert.equal(inPlay(ctx({ matches: [{ isFinished: false, startsAt: iso(30 * H) }] }), now), false, 'demain soir');
  assert.equal(
    inPlay(ctx({ matches: [{ isFinished: false, resultType: 'CANCELLED', startsAt: iso(H) }] }), now),
    false,
  );
  assert.equal(inPlay(ctx({ matches: [{ isFinished: true, resultRegisteredAt: iso(-H) }] }), now), true);
  assert.equal(inPlay(ctx({ matches: [{ isFinished: true, resultRegisteredAt: iso(-5 * H) }] }), now), false);
  assert.equal(inPlay(ctx({ pools: [{ isFinal: false, closesAt: iso(2 * H), fencers: [] }] }), now), true);
  assert.equal(inPlay(ctx({ reopened: [12] }), now), true);
  assert.equal(nextDispatchDelay(true, now), 30000);
  assert.equal(nextDispatchDelay(false, now), idle.untilSlot(10000, now));
});

test('surveillance : une tâche en veille annonce son prochain passage et n’est pas jugée bloquée', () => {
  const base = { now: T, uptime: 3600, enabled: { ftl: true } };
  const at = T - 10 * 60000;
  assert.equal(workerHealth({ ...base, beat: () => at, expected: () => null }).ftl.stale, true, 'sans annonce : 5 min');
  assert.equal(
    workerHealth({ ...base, beat: () => at, expected: () => 15 * 60000 }).ftl.stale,
    false,
    'veille annoncée',
  );
  assert.equal(
    workerHealth({ ...base, beat: () => T - 20 * 60000, expected: () => 15 * 60000 }).ftl.stale,
    true,
    'au-delà du passage annoncé + 2 min',
  );
});

test('réveil : une action d’administration réveille les tâches enregistrées', () => {
  let woken = 0;
  const off = idle.registerWake('test', () => woken++);
  idle.wakeAll();
  off();
  idle.wakeAll();
  assert.equal(woken, 1);
});

test('réveil de la base : échecs passagers retentés vite, délai de connexion de 30 s', () => {
  assert.equal(idle.dbWaking({ code: 'P1001' }), true, 'base injoignable');
  assert.equal(idle.dbWaking({ code: 'P2028' }), true, 'transaction expirée pendant le réveil');
  assert.equal(idle.dbWaking({ message: "Can't reach database server at `ep-x`" }), true);
  assert.equal(idle.dbWaking({ code: 'P2002' }), false, 'vraie erreur de données');
  assert.equal(idle.dbWaking(new Error('boom')), false);
  assert.deepEqual([1, 2, 3, 4].map(idle.retryDelay), [15000, 30000, 60000, 60000]);
  const { databaseUrl } = require('../src/lib/databaseUrl');
  assert.equal(databaseUrl('postgresql://u@h/db'), 'postgresql://u@h/db?connect_timeout=30');
  assert.equal(
    databaseUrl('postgresql://u@h/db?sslmode=require'),
    'postgresql://u@h/db?sslmode=require&connect_timeout=30',
  );
  assert.equal(databaseUrl('postgresql://u@h/db?connect_timeout=10'), 'postgresql://u@h/db?connect_timeout=10');
  assert.equal(databaseUrl(''), '');
});
