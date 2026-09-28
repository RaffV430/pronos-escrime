const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';

function fixture() {
  const tournament = {
    id: 4,
    name: 'Challenge de Paris',
    archivedAt: null,
    completionNextCheckAt: null,
    competitions: [
      {
        id: 10,
        name: 'Fleuret hommes',
        matches: [{ id: 1, isFinished: false, resultType: null }],
        pools: [],
        matchRounds: [],
      },
      {
        id: 11,
        name: 'Fleuret dames',
        matches: [{ id: 2, isFinished: true, resultType: 'NORMAL' }],
        pools: [],
        matchRounds: [],
      },
    ],
  };
  const states = [
    { competitionId: 10, status: 'READY', nextAutomaticAt: new Date() },
    { competitionId: 11, status: 'COMPLETE', nextAutomaticAt: null },
  ];
  const audit = [];
  const db = {
    $queryRaw: async () => [],
    tournament: {
      findUnique: async ({ where }) => (where.id === 4 ? tournament : null),
      update: async ({ data }) => Object.assign(tournament, data),
    },
    ftlSyncState: {
      findMany: async () => states,
      updateMany: async ({ where, data }) => {
        const hit = states.filter(
          (s) => where.competitionId.in.includes(s.competitionId) && s.status !== where.NOT?.status,
        );
        hit.forEach((s) => Object.assign(s, data));
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }) => audit.push(data) },
    user: { findUnique: async ({ where }) => ({ isAdmin: where.id === 1 }) },
  };
  db.$transaction = (fn) => fn(db);
  return { db, tournament, states, audit };
}

test('admin archives a whole tournament: hidden, FTL follow-up stopped, logged; can be undone', async (t) => {
  const f = fixture();
  require.cache[require.resolve('../src/lib/prisma')] = { exports: f.db };
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/admin', require('../src/routes/adminRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const call = (path, method = 'GET', body, userId = 1) =>
    fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  assert.equal((await call('/tournaments/4/archive', 'POST', { confirm: true }, 2)).status, 403, 'admins only');
  const status = await (await call('/tournaments/4/archive')).json();
  assert.equal(status.openMatches, 1);
  assert.deepEqual(
    status.competitions.map((c) => c.complete),
    [false, false],
  );
  assert.equal((await call('/tournaments/4/archive', 'POST', {})).status, 400, 'explicit confirmation');

  f.states[0].status = 'RUNNING';
  assert.equal(
    (await call('/tournaments/4/archive', 'POST', { confirm: true })).status,
    409,
    'not during an FTL check',
  );
  f.states[0].status = 'READY';

  assert.equal((await call('/tournaments/4/archive', 'POST', { confirm: true })).status, 200);
  assert.ok(f.tournament.archivedAt);
  assert.ok(
    f.states.every((s) => s.nextAutomaticAt === null),
    'automatic follow-up stopped',
  );
  assert.equal(f.audit.at(-1).action, 'Tournoi archivé manuellement');
  assert.deepEqual(f.audit.at(-1).after.incomplete, ['Fleuret hommes', 'Fleuret dames']);
  assert.equal((await call('/tournaments/4/archive', 'POST', { confirm: true })).status, 409, 'already archived');

  assert.equal((await call('/tournaments/4/unarchive', 'POST')).status, 200);
  assert.equal(f.tournament.archivedAt, null);
  assert.ok(f.states[0].nextAutomaticAt instanceof Date, 'unfinished event followed again');
  assert.equal(f.states[1].nextAutomaticAt, null, 'finished event left alone');
  assert.equal((await call('/tournaments/99/archive')).status, 404);
});
