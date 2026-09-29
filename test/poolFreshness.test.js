const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const { load } = require('cheerio');
const { startedOnSource, startedPositions, _cache } = require('../src/services/poolFreshness');
const { createPoolRouter } = require('../src/routes/poolRoutes');
process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';

const blank = () => {
  const $ = load(fs.readFileSync(`${__dirname}/fixtures/ftl-pools.html`, 'utf8'));
  $('table.poolTable').slice(1).parent().remove();
  $('.poolScore').text('');
  return $;
};

test('positions with a score on FTL: both fencers of a published bout, withdrawals, nothing else', () => {
  const $ = blank();
  assert.deepEqual([...startedPositions($).get(1)], []);
  $('.poolRow').eq(0).children('td').eq(3).text('V5'); // 1 contre 2, une seule moitié saisie
  assert.deepEqual([...startedPositions($).get(1)].sort(), [1, 2]);
  const full = load(fs.readFileSync(`${__dirname}/fixtures/ftl-pools.html`, 'utf8'));
  const all = startedPositions(full);
  assert.ok(all.size > 1 && [...all.values()].every((s) => s.size > 0));
});

test('startedOnSource: checks FTL only when useful, shares one read, fails open', async () => {
  _cache.clear();
  const now = new Date('2026-09-29T08:16:30Z');
  const pool = {
    lockMode: 'FIRST_RESULT',
    sourceUrl: 'https://www.fencingtimelive.com/pools/scores/A/B',
    sourcePoolNumber: 2,
    sourceCheckedAt: new Date('2026-09-29T08:15:19Z'),
  };
  let reads = 0;
  const read = async () => (reads++, new Map([[2, new Set([1, 4])]]));
  assert.equal(await startedOnSource(pool, { position: 1 }, { now, read }), true);
  assert.equal(await startedOnSource(pool, { position: 3 }, { now, read }), false);
  assert.equal(reads, 1, 'one FTL read serves every player for 30 s');
  // Contrôle automatique récent, épreuve pas commencée, poule saisie à la main : pas de lecture.
  assert.equal(
    await startedOnSource({ ...pool, sourceCheckedAt: new Date(now - 10000) }, { position: 1 }, { now, read }),
    null,
  );
  assert.equal(await startedOnSource(pool, { position: 1 }, { now, start: now.getTime() + 3600e3, read }), null);
  assert.equal(await startedOnSource({ ...pool, lockMode: 'TIME' }, { position: 1 }, { now, read }), null);
  // FTL indisponible ou trop lent : règle habituelle (null), jamais de blocage inventé.
  _cache.clear();
  assert.equal(
    await startedOnSource(pool, { position: 1 }, { now, read: async () => Promise.reject(new Error('down')) }),
    null,
  );
  _cache.clear();
  assert.equal(
    await startedOnSource(pool, { position: 1 }, { now, timeout: 20, read: () => new Promise(() => {}) }),
    null,
  );
  _cache.clear();
});

test('saving a pool prediction is refused once FTL shows the fencer started, and the check is brought forward', async (t) => {
  const pool = {
    id: 1,
    competitionId: 9,
    name: 'Poule 2',
    lockMode: 'FIRST_RESULT',
    sourceUrl: 'https://www.fencingtimelive.com/pools/scores/A/B',
    sourcePoolNumber: 2,
    sourceCheckedAt: new Date(Date.now() - 60000),
    closesAt: new Date(),
    isLocked: false,
    isFinal: false,
    fencers: [
      { id: 10, position: 1, name: 'Alice' },
      { id: 20, position: 2, name: 'Bob' },
    ],
  };
  const saved = [];
  const nudges = [];
  const db = {
    $queryRaw: async () => [{ id: 1 }],
    $transaction: async (fn) => fn(db),
    user: { findUnique: async () => ({ isAdmin: false, sessionVersion: 0 }) },
    pool: { findUnique: async () => pool },
    competition: { findUnique: async () => null },
    ftlSyncState: { updateMany: async (q) => (nudges.push(q), { count: 1 }) },
    poolPrediction: {
      upsert: async ({ create }) => (saved.push(create), create),
      deleteMany: async () => ({ count: 1 }),
    },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const started = new Set([10]);
  const app = express();
  app.use(express.json());
  app.use('/pools', createPoolRouter(db, { sourceCheck: async (p, f) => started.has(f.id) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const put = (fencerId, method = 'PUT') =>
    fetch(`http://127.0.0.1:${server.address().port}/pools/1/fencers/${fencerId}/prediction`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.sign({ userId: 1, sv: 0 }, process.env.JWT_SECRET)}`,
      },
      body: method === 'PUT' ? JSON.stringify({ wins: 1, losses: 0, indicator: 3 }) : undefined,
    });
  const refused = await put(10);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /déjà commencé/);
  assert.equal((await put(10, 'DELETE')).status, 409);
  assert.equal(saved.length, 0);
  assert.deepEqual(nudges[0].where, { competitionId: 9, leaseToken: null });
  assert.equal((await put(20)).status, 200);
  assert.equal(saved.length, 1);
});
