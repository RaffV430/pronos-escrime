const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createPoolRouter } = require('../src/routes/poolRoutes');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';

function fixture() {
  const pool = { id: 1, competitionId: 1, name: 'Test', closesAt: new Date(Date.now() + 3600000), isLocked: false, isFinal: false,
    fencers: [{ id: 10, position: 1, name: 'Alice' }, { id: 20, position: 2, name: 'Bob' }] };
  const predictions = [];
  let locked = false;
  const db = {
    $queryRaw: async () => { locked = true; return [{ id: 1 }]; },
    pool: {
      findUnique: async () => pool,
      update: async ({ data }) => Object.assign(pool, data),
      findMany: async ({ include }) => [{ ...pool, fencers: pool.fencers.map(f => ({ ...f,
        predictions: predictions.filter(p => p.fencerId === f.id && p.userId === include.fencers.include.predictions.where.userId),
      })) }],
    },
    poolFencer: { update: async ({ where, data }) => Object.assign(pool.fencers.find(f => f.id === where.id), data) },
    poolPrediction: {
      upsert: async ({ where, create, update }) => {
        assert.equal(locked, true, 'prediction writes require the pool row lock');
        let p = predictions.find(p => p.userId === where.userId_fencerId.userId && p.fencerId === where.userId_fencerId.fencerId);
        if (p) Object.assign(p, update);
        else { p = { id: predictions.length + 1, pointsEarned: 0, ...create }; predictions.push(p); }
        return p;
      },
      deleteMany: async ({ where }) => { const i = predictions.findIndex(p => p.userId === where.userId && p.fencerId === where.fencerId); if (i >= 0) predictions.splice(i, 1); },
      findMany: async ({ where }) => predictions.filter(p => p.fencerId === where.fencerId),
      update: async ({ where, data }) => Object.assign(predictions.find(p => p.id === where.id), data),
    },
  };
  db.$transaction = async fn => { locked = false; return fn(db); };
  return { db, pool, predictions };
}

test('HTTP authentication, ownership, closure and corrected results', async t => {
  const { db, pool, predictions } = fixture();
  const app = express(); app.use(express.json()); app.use('/pools', createPoolRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/pools`;
  const request = async (path, method = 'GET', body, userId = 1, isAdmin = false) => {
    const headers = { 'Content-Type': 'application/json' };
    if (userId) headers.Authorization = `Bearer ${jwt.sign({ userId, isAdmin }, process.env.JWT_SECRET)}`;
    return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  assert.equal((await request('?competitionId=1', 'GET', undefined, null)).status, 401);
  assert.equal((await request('/1/close', 'POST')).status, 403);
  assert.equal((await request('?competitionId=1bad')).status, 400);
  assert.equal((await request('/1/fencers/999/prediction', 'PUT', { wins: 1, losses: 0, indicator: 3 })).status, 404);
  assert.equal((await request('/1/fencers/10/prediction', 'PUT', { wins: 1, losses: 1, indicator: 3 })).status, 400);
  assert.equal((await request('/1/fencers/10/prediction', 'PUT', { wins: 1, losses: 0, indicator: 3 })).status, 200);
  assert.equal((await request('/1/fencers/10/prediction', 'PUT', { wins: 0, losses: 1, indicator: -4 }, 2)).status, 200);
  const own = await (await request('?competitionId=1')).json();
  assert.equal(own[0].fencers[0].prediction.userId, 1);
  assert.equal(own[0].fencers[0].predictions, undefined);
  const results = [{ fencerId: 10, wins: 1, losses: 0, indicator: 3 }, { fencerId: 20, wins: 0, losses: 1, indicator: -3 }];
  assert.equal((await request('/1/results', 'PUT', { results }, 1, true)).status, 409);
  pool.closesAt = new Date(Date.now() - 1000);
  assert.equal((await request('/1/fencers/10/prediction', 'PUT', { wins: 0, losses: 1, indicator: -3 })).status, 409);
  assert.equal((await request('/1/fencers/10/prediction', 'DELETE')).status, 409);
  assert.equal((await request('/1/results', 'PUT', { results }, 1, true)).status, 200);
  assert.equal(predictions[0].pointsEarned, 8);
  assert.equal(predictions[1].pointsEarned, 1);
  assert.equal((await request('/1/results', 'PUT', { results }, 1, true)).status, 200);
  assert.equal(predictions[0].pointsEarned, 8, 'republishing does not accumulate');
  const corrected = results.map(r => ({ ...r, wins: 1 - r.wins, losses: 1 - r.losses, indicator: -r.indicator }));
  assert.equal((await request('/1/results', 'PUT', { results: corrected }, 1, true)).status, 200);
  assert.equal(predictions[0].pointsEarned, 1, 'correction removes previous points');
  assert.equal(predictions[1].pointsEarned, 6);
  assert.equal(pool.isFinal, true);
});

test('HTTP individual locks reject creation, edits and deletion while another fencer stays open', async t => {
  const { db, pool, predictions } = fixture();
  pool.lockMode = 'FIRST_RESULT';
  pool.closesAt = new Date('2000-01-01');
  pool.sourceCheckedAt = new Date();
  const app = express(); app.use(express.json()); app.use('/pools', createPoolRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = async (path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/pools${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const pick = { wins: 1, losses: 0, indicator: 3 };
  assert.equal((await request('/1/fencers/10/prediction', 'PUT', pick)).status, 200);
  pool.fencers[0].firstResultAt = new Date();
  assert.equal((await request('/1/fencers/10/prediction', 'PUT', { ...pick, wins: 0, losses: 1, indicator: -3, firstResultAt: null })).status, 409);
  assert.equal((await request('/1/fencers/10/prediction', 'DELETE')).status, 409);
  assert.equal(predictions[0].wins, 1);
  assert.equal((await request('/1/fencers/20/prediction', 'PUT', pick)).status, 200);
  let rows = await (await request('?competitionId=1')).json();
  assert.equal(rows[0].isClosed, false);
  assert.equal(rows[0].fencers[0].isClosed, true);
  assert.equal(rows[0].fencers[1].isClosed, false);
  pool.sourceCheckedAt = new Date(Date.now() - 180001);
  assert.equal((await request('/1/fencers/20/prediction', 'PUT', pick)).status, 409);
  pool.sourceCheckedAt = new Date();
  assert.equal((await request('/1/fencers/20/prediction', 'DELETE')).status, 204);
  assert.equal((await request('/1/fencers/10/prediction', 'DELETE')).status, 409);
  pool.isLocked = true;
  assert.equal((await request('/1/fencers/20/prediction', 'PUT', pick)).status, 409);
});
