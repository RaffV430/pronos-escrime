const { test } = require('node:test');
const assert = require('node:assert/strict');

test('F1: standings are summed by the database (GROUP BY), never by loading every prediction', async () => {
  const { computeStandings } = require('../src/services/standings');
  const grouped = [];
  const groupBy = (rows) => async (args) => {
    grouped.push(args);
    return rows;
  };
  const noFindMany = async () => assert.fail('predictions must not be loaded one by one');
  const db = {
    competition: { findMany: async () => [{ id: 10 }] },
    user: {
      findMany: async () => [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    },
    podiumPrediction: { groupBy: groupBy([{ userId: 1, _sum: { pointsEarned: 20 } }]), findMany: noFindMany },
    prediction: {
      groupBy: groupBy([
        { userId: 1, _sum: { pointsEarned: 7, bonusPoints: 1 } },
        { userId: 2, _sum: { pointsEarned: 12, bonusPoints: null } },
      ]),
      findMany: noFindMany,
    },
    poolPrediction: { groupBy: groupBy([{ userId: 2, _sum: { pointsEarned: 8 } }]), findMany: noFindMany },
    pointAdjustment: { groupBy: groupBy([{ userId: 2, _sum: { points: -3 } }]), findMany: noFindMany },
    challenge: { findMany: async () => [] },
    match: { findMany: async () => [] },
  };
  const rows = await computeStandings(db, { tournamentId: 3 });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[1].totalPoints, 28);
  assert.equal(byId[1].outsiderPoints, 1);
  assert.equal(byId[2].totalPoints, 17);
  assert.deepEqual(grouped[1].where, { match: { competitionId: { in: [10] } } });
  assert.deepEqual(grouped[1].by, ['userId']);
  // Classement général : aucun filtre par liste d'épreuves.
  grouped.length = 0;
  await computeStandings(db, {});
  assert.deepEqual(grouped[1].where, {});
});

test('F1: only writes that can change points empty the standings cache', () => {
  const { changesPoints } = require('../src/services/standings');
  for (const [method, path] of [
    ['POST', '/api/matches/12/predict'],
    ['DELETE', '/api/matches/12/predict'],
    ['PUT', '/api/pools/3/fencers/7/prediction'],
    ['POST', '/api/podium'],
    ['POST', '/api/notifications/subscribe'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/community/challenges/4/pick'],
    ['GET', '/api/admin/audit'],
  ])
    assert.equal(changesPoints(method, path), false, `${method} ${path}`);
  for (const [method, path] of [
    ['PUT', '/api/matches/12/result'],
    ['PUT', '/api/pools/3/results'],
    ['POST', '/api/admin/adjust-points'],
    ['POST', '/api/podium/competition/5/resolve'],
    ['DELETE', '/api/auth/account'],
  ])
    assert.equal(changesPoints(method, path), true, `${method} ${path}`);
});

test('F1: the standings cache stays bounded', async () => {
  const { standings } = require('../src/services/standings');
  let computed = 0;
  const db = {
    competition: { findMany: async () => [] },
    user: { findMany: async () => (computed++, []) },
    podiumPrediction: { groupBy: async () => [] },
    prediction: { groupBy: async () => [] },
    poolPrediction: { groupBy: async () => [] },
    pointAdjustment: { groupBy: async () => [] },
    challenge: { findMany: async () => [] },
    match: { findMany: async () => [] },
  };
  for (let i = 1; i <= 80; i++) await standings(db, { competitionId: i });
  await standings(db, { competitionId: 80 });
  assert.equal(computed, 80, 'recent keys are served from cache');
  await standings(db, { competitionId: 1 });
  assert.equal(computed, 81, 'the oldest keys were evicted (50 kept at most)');
});

test('F3: unexpected errors are reported once, without data; expected ones are not', () => {
  const { reportError } = require('../src/lib/report');
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args);
  try {
    reportError(Object.assign(new Error('Match introuvable'), { status: 404 }), 'match');
    assert.equal(lines.length, 0, 'an expected error (with status) is not reported');
    reportError(Object.assign(new Error('Timed out fetching a new connection'), { code: 'P2024' }), 'classement');
    assert.equal(lines.length, 1);
    assert.ok(
      lines[0].every((a) => typeof a === 'string'),
      'strings only: no object with request data',
    );
    assert.match(lines[0].join(' '), /classement.*P2024.*Timed out/);
  } finally {
    console.error = original;
  }
});

test('F4: sync health levels for the admin view', () => {
  const { health } = require('../src/services/syncHealth');
  const c = { id: 5, name: 'Fleuret hommes', tournament: { name: 'Challenge' } };
  const now = Date.parse('2026-10-10T10:00:00Z');
  const at = (min) => new Date(now + min * 60000);
  assert.equal(health(null, c, now).level, 'waiting');
  assert.equal(health({ status: 'READY', failures: 0, nextAutomaticAt: at(1) }, c, now).level, 'ok');
  assert.equal(health({ status: 'READY', failures: 0, nextAutomaticAt: at(-15) }, c, now).level, 'warning', 'late');
  assert.equal(health({ status: 'ATTENTION', failures: 0, nextAutomaticAt: at(1) }, c, now).level, 'warning');
  assert.equal(health({ status: 'ERROR', failures: 1, nextAutomaticAt: at(2) }, c, now).level, 'error');
  assert.equal(health({ status: 'COMPLETE', failures: 0, nextAutomaticAt: at(-600) }, c, now).level, 'ok');
});

test('F4: admins are alerted once at the 3rd failure in a row, then when it recovers', async () => {
  const { alertAdmins } = require('../src/services/syncHealth');
  const mails = [],
    pushes = [];
  const db = {
    competition: { findUnique: async () => ({ name: 'Fleuret hommes' }) },
    user: { findMany: async () => [{ id: 1, email: 'maitre@example.fr', name: 'Maître' }] },
    pushSubscription: { findMany: async () => [{ id: 's1', userId: 1 }] },
  };
  const deps = {
    mailer: { mailConfigured: () => true, sendMail: async (m) => mails.push(m) },
    push: { configured: () => true, send: async (sub, content) => pushes.push(content) },
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await alertAdmins(db, { competitionId: 5, failures: 2, previousFailures: 1, error: 'x' }, deps), null);
    const down = await alertAdmins(db, { competitionId: 5, failures: 3, previousFailures: 2, error: 'FTL 503' }, deps);
    assert.deepEqual(down, { kind: 'down', mail: 1, push: 1 });
    assert.match(mails[0].subject, /en panne · Fleuret hommes/);
    assert.match(mails[0].text, /FTL 503/);
    assert.equal(await alertAdmins(db, { competitionId: 5, failures: 4, previousFailures: 3 }, deps), null, 'no spam');
    const up = await alertAdmins(db, { competitionId: 5, failures: 0, previousFailures: 4 }, deps);
    assert.equal(up.kind, 'recovered');
    assert.match(pushes[1].title, /rétabli/);
    assert.equal(await alertAdmins(db, { competitionId: 5, failures: 0, previousFailures: 1 }, deps), null);
  } finally {
    console.error = original;
  }
});

test('F6: due events are checked in parallel (3 at a time); events not due are not even loaded', async () => {
  const { tick } = require('../src/services/ftlScheduler');
  const ids = [
    'F11BB8AC692C4073BA38A7592EC7309E',
    '647A20DB3116411181393C8F779CD2A4',
    '3E02F3DE23C54C7683C06B07F23E85F4',
  ];
  let queried;
  const db = {
    competition: {
      findMany: async ({ where }) => {
        queried = where;
        return [...ids, ids[0]]
          .map((id, i) => ({ id: i + 5, rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${id}` }))
          .filter((c) => !where.id?.notIn.includes(c.id));
      },
    },
    auditLog: { findFirst: async () => null },
    ftlSyncState: {
      findMany: async () => [{ competitionId: 8, nextAutomaticAt: new Date('2026-09-30'), leaseUntil: null }],
    },
  };
  let active = 0,
    peak = 0;
  const outcomes = await tick(db, {
    archive: async () => [],
    now: new Date('2026-09-28'),
    sync: async (db, id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      if (id === 6) throw Object.assign(Error('upstream'), { status: 503 });
      return { created: 1 };
    },
  });
  assert.deepEqual(queried.id, { notIn: [8] }, 'the event not due yet is not loaded');
  assert.equal(peak, 3, 'three checks at the same time');
  assert.deepEqual(
    outcomes.map((o) => [o.competitionId, o.ok]),
    [
      [5, true],
      [6, false],
      [7, true],
    ],
  );
});

test('F5: cleanup removes only old notification rows, routine sync traces and old ranking snapshots', async () => {
  const { cleanup } = require('../src/services/maintenance');
  const calls = {};
  const db = {
    pushDelivery: { deleteMany: async (a) => ((calls.deliveries = a), { count: 4 }) },
    pushEvent: { deleteMany: async (a) => ((calls.events = a), { count: 1 }) },
    auditLog: { deleteMany: async (a) => ((calls.routine = a), { count: 10 }) },
    $executeRaw: async (strings, ...values) => ((calls.snapshots = [strings.join('?'), values]), 3),
  };
  const now = new Date('2026-10-31T00:00:00Z');
  db.appSetting = { findUnique: async () => null }; // pas de club configuré
  assert.deepEqual(await cleanup(db, now), { deliveries: 4, events: 1, routine: 10, snapshots: 3, clubLeagues: 0 });
  assert.deepEqual(calls.deliveries.where.status, { in: ['SENT', 'CANCELLED', 'FAILED'] }, 'pending ones are kept');
  assert.equal(calls.deliveries.where.createdAt.lt.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepEqual(
    calls.routine.where.action,
    { in: ['Contrôle FTL démarré', 'Contrôle FTL terminé'] },
    'admin actions and failures are kept',
  );
  assert.match(calls.snapshots[0], /rang > 2/, 'the two latest snapshots per ranking are kept');
});

test('F7/F9: stopping a worker returns the pass in progress so shutdown can wait for it', async () => {
  process.env.FTL_AUTO_SYNC = 'true';
  const { startWorker } = require('../src/services/ftlScheduler');
  let release;
  const db = {
    ftlSyncState: { findMany: () => new Promise((r) => (release = () => r([]))) },
    competition: { findMany: async () => [] },
    tournament: { findMany: async () => [] },
  };
  const log = console.log;
  console.log = () => {};
  const stop = startWorker(db);
  console.log = log;
  const pending = stop();
  let done = false;
  pending.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, 'the pass in progress is still running');
  release();
  await pending;
  assert.ok(require('../src/lib/heartbeat').lastBeat('ftl'), 'a finished pass records its heartbeat for /health');
  delete process.env.FTL_AUTO_SYNC;
});
