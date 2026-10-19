// Mesure explicite sur HTTP localhost et données synthétiques. Aucune base ou source officielle.
const http = require('node:http');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const express = require('express');
const compression = require('compression');
const live = require('../src/services/ftlLiveScores');
const router = require('../src/routes/publicRoutes');
function fixtures() {
  return Array.from({ length: 32 }, (_, i) => ({
    matchId: 90000 + i,
    finished: false,
    started: true,
    strip: String(i + 1),
    score1: 5,
    score2: 4,
    clock: 150,
    fencer1: { name: `Fictif ${i} A`, lamp: false },
    fencer2: { name: `Fictif ${i} B`, lamp: false },
    history: Array.from({ length: 40 }, (_, j) => ({
      l: j % 10,
      r: (j + 1) % 10,
      by: 'left',
      clock: 180 - j,
      period: 1,
      at: '2026-01-01T00:00:00.000Z',
    })),
  }));
}
function apply(previous, packet) {
  if (Array.isArray(packet)) return packet;
  const rows = new Map((packet.reset ? [] : previous).map((r) => [r.matchId, r]));
  for (const id of packet.removed) rows.delete(id);
  for (const patch of packet.matches) {
    const row = { ...rows.get(patch.matchId), ...patch };
    if (patch.historyAppend) {
      assert.equal(row.history.length, patch.historyFrom);
      row.history = [...row.history, ...patch.historyAppend];
    }
    delete row.historyAppend;
    delete row.historyFrom;
    rows.set(row.matchId, row);
  }
  return [...rows.values()];
}
async function measure({ delta = false, gzip = false, updates = 12 } = {}) {
  let rows = fixtures(),
    notify,
    unsubscribed = 0,
    calls = 0;
  const oldFor = live.liveFor,
    oldSubscribe = live.subscribe;
  live.liveFor = async () => {
    calls++;
    return structuredClone(rows);
  };
  live.subscribe = async (_db, _id, cb) => {
    notify = cb;
    return () => unsubscribed++;
  };
  const app = express();
  app.use(compression({ threshold: 1024 }));
  if (!gzip)
    app.use((_req, res, next) => {
      const original = res.set.bind(res);
      res.set = function (field, value) {
        if (typeof field === 'object')
          return original(
            field['Content-Type'] === 'text/event-stream'
              ? { ...field, 'Cache-Control': 'no-cache, no-transform' }
              : field,
          );
        return original(field, value);
      };
      next();
    });
  let clientClosed;
  const disconnected = new Promise((resolve) => {
    clientClosed = resolve;
  });
  app.use((_req, res, next) => {
    res.once('close', clientClosed);
    next();
  });
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let bytes = 0,
    state = [],
    frames = 0,
    input = '',
    currentResolve,
    wireEncoding,
    request,
    response,
    decoder;
  const expectedStates = [];
  try {
    const nextFrame = () =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('SSE non reçu immédiatement')), 2000);
        currentResolve = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    let next = nextFrame();
    await new Promise((resolve, reject) => {
      request = http.get(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: `/competitions/20/live/stream${delta ? '?delta=1' : ''}`,
          headers: { 'Accept-Encoding': 'gzip' },
        },
        (res) => {
          response = res;
          wireEncoding = res.headers['content-encoding'] || 'identity';
          res.on('data', (chunk) => {
            bytes += chunk.length;
          });
          decoder = wireEncoding === 'gzip' ? zlib.createGunzip() : null;
          const stream = decoder ? res.pipe(decoder) : res;
          stream.on('data', (chunk) => {
            input += chunk.toString();
            let end;
            while ((end = input.indexOf('\n\n')) >= 0) {
              const frame = input.slice(0, end);
              input = input.slice(end + 2);
              if (!frame.startsWith('data: ')) continue;
              state = apply(state, JSON.parse(frame.slice(6)));
              frames++;
              assert.deepEqual(state, expectedStates.shift());
              currentResolve?.();
            }
          });
          resolve();
        },
      );
      request.on('error', reject);
      expectedStates.push(structuredClone(rows));
    });
    await next;
    assert.equal(wireEncoding, gzip ? 'gzip' : 'identity');
    const deliveries = [];
    for (let n = 0; n < updates; n++) {
      rows = structuredClone(rows);
      rows[0].clock--;
      rows[0].fencer1.lamp = n % 2 === 0;
      if (n === 3)
        rows[0].history.push({ l: 6, r: 4, by: 'left', clock: 140, period: 1, at: '2026-01-01T00:00:01.000Z' });
      if (n === 6) rows[0].history[0] = { ...rows[0].history[0], by: 'correction' };
      if (n === 9) rows.pop();
      expectedStates.push(structuredClone(rows));
      next = nextFrame();
      const sentAt = performance.now();
      notify();
      await next;
      deliveries.push(performance.now() - sentAt);
    }
    assert.equal(expectedStates.length, 0);
    return { delta, gzip, bytes, frames, calls, identical: true, maxDeliveryMs: Math.round(Math.max(...deliveries)) };
  } finally {
    response?.destroy();
    request?.destroy();
    decoder?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await disconnected;
    await new Promise((resolve) => setImmediate(resolve));
    live.liveFor = oldFor;
    live.subscribe = oldSubscribe;
    assert.equal(unsubscribed, 1);
  }
}
module.exports = { measure };
if (require.main === module) {
  (async () => {
    const results = [];
    for (const delta of [false, true]) for (const gzip of [false, true]) results.push(await measure({ delta, gzip }));
    console.log(
      JSON.stringify(
        {
          fixture: '32 rencontres synthétiques, 40 touches chacune, 12 mises à jour dont correction et suppression',
          results,
        },
        null,
        2,
      ),
    );
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
