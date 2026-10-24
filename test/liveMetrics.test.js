const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveMetrics } = require('../src/lib/liveMetrics');
function response() {
  return Object.assign(new EventEmitter(), { write: () => true, end() {} });
}
function fixture() {
  let time = 0;
  const logs = [];
  const metrics = createLiveMetrics({
    enabled: true,
    now: () => time,
    wall: () => 'minute',
    log: (r) => logs.push(r),
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  });
  return {
    metrics,
    logs,
    at: (t) => {
      time = t;
    },
  };
}
test('désactivé par défaut : aucune mesure, timer ou modification de réponse', () => {
  const m = createLiveMetrics({ setTimer: () => assert.fail('timer') });
  const res = response(),
    before = res.write;
  m.middleware({}, res, () => {});
  m.begin(res, {}).message('secret', 'secret');
  m.flush();
  m.stop();
  assert.equal(res.write, before);
  assert.equal(res.listenerCount('close'), 0);
});
test('temps de connexion intégré sur les minutes, pic et fermetures idempotentes', () => {
  const f = fixture(),
    a = response(),
    b = response();
  const first = f.metrics.begin(a, { delta: true, packedWire: true });
  f.at(10000);
  f.metrics.begin(b, { delta: true, packedWire: true });
  f.at(60000);
  f.metrics.flush();
  assert.equal(f.logs[0].rows[0].connection_ms, 110000);
  assert.equal(f.logs[0].rows[0].peak, 2);
  f.at(70000);
  first.close();
  first.close();
  a.emit('close');
  f.at(120000);
  f.metrics.flush();
  assert.equal(f.logs[1].rows[0].connection_ms, 70000);
  assert.equal(f.logs[1].rows[0].closed, 1);
  assert.equal(f.logs[1].rows[0].active, 1);
  assert.equal(a.listenerCount('error'), 0);
  f.metrics.stop();
});
test('Unicode, enveloppe, ping et nettoyage : aucun contenu ni identifiant dans les logs', () => {
  const f = fixture(),
    res = response();
  f.metrics.middleware({ ip: 'PRIVATE-IP', url: '/private/123', user: { id: 456 } }, res, () => {});
  const session = f.metrics.begin(res, { delta: true, packedWire: false, name: 'PRIVATE-NAME' });
  const body = JSON.stringify({ name: 'PRIVATE-NAME 🤺' });
  res.write('data: ' + body + '\n\n');
  session.message(body, body);
  res.end(': ping\n\n');
  res.emit('error');
  session.close();
  f.metrics.flush();
  const row = f.logs[0].rows[0];
  assert.equal(row.json_bytes, Buffer.byteLength(body));
  assert.equal(row.wire_json_bytes, row.json_bytes);
  assert.equal(row.origin_body_bytes, Buffer.byteLength(body) + 16);
  assert.equal(row.closed, 1);
  assert.equal(row.packed_messages, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|123|456|name|ip|user/);
  f.metrics.stop();
});
test('groupe borné à quatre formats ; mesures après fermeture ignorées', () => {
  const f = fixture();
  for (const delta of [false, true])
    for (const packedWire of [false, true]) {
      const s = f.metrics.begin(response(), { delta, packedWire });
      s.message('12345', '12');
      s.close();
      s.message('late', 'late');
    }
  f.metrics.flush();
  assert.equal(f.logs[0].rows.length, 4);
  for (const row of f.logs[0].rows) {
    assert.equal(row.messages, 1);
    assert.equal(row.packed_messages, 1);
  }
  f.metrics.stop();
});
test('panne du journal sans effet sur le flux, arrêt idempotent', () => {
  const f = createLiveMetrics({
    enabled: true,
    log() {
      throw Error('offline');
    },
    setTimer: () => 0,
    clearTimer() {},
  });
  const s = f.begin(response(), {});
  assert.doesNotThrow(() => {
    f.flush();
    s.close();
    f.stop();
    f.stop();
  });
});
test('vrai HTTP gzip : compte les octets encodés, contenu et protocole inchangés', async () => {
  const express = require('express'),
    compression = require('compression'),
    http = require('node:http');
  const { gunzipSync } = require('node:zlib');
  const { encodeLiveWire } = require('../src/services/liveWire');
  const f = fixture(),
    app = express();
  app.use(f.metrics.middleware);
  app.use(compression({ threshold: 0 }));
  const body = JSON.stringify({ matches: [{ label: 'Synthétique é🤺'.repeat(400) }] });
  const wire = await encodeLiveWire(body, true);
  app.get('/', (req, res) => {
    res.set('Content-Type', 'text/event-stream');
    const s = f.metrics.begin(res, { delta: true, packedWire: true });
    res.write(`data: ${wire}\n\n`);
    s.message(body, wire);
    res.flush();
    res.end(': ping\n\n');
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const data = await new Promise((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port: server.address().port, headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
          assert.equal(res.headers['content-encoding'], 'gzip');
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject),
    );
    assert.equal(gunzipSync(data).toString(), `data: ${wire}\n\n: ping\n\n`);
    f.metrics.flush();
    const row = f.logs[0].rows[0];
    assert.equal(row.origin_body_bytes, data.length);
    assert.equal(row.json_bytes, Buffer.byteLength(body));
    assert.equal(row.wire_json_bytes, Buffer.byteLength(wire));
    assert.ok(row.wire_json_bytes < row.json_bytes);
    assert.equal(row.active, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.metrics.stop();
  }
});

test('route réelle : ne compte que les messages acceptés et ferme la mesure une seule fois', async () => {
  const live = require('../src/services/ftlLiveScores');
  const { liveMetrics } = require('../src/lib/liveMetrics');
  const router = require('../src/routes/publicRoutes');
  const handler = router.stack.find((l) => l.route?.path === '/competitions/:competitionId/live/stream').route.stack[0]
    .handle;
  const original = { begin: liveMetrics.begin, liveFor: live.liveFor, subscribe: live.subscribe };
  const calls = [];
  liveMetrics.begin = () => ({ message: (body, wire) => calls.push([body, wire]), close: () => calls.push('closed') });
  live.liveFor = async () => [];
  live.subscribe = async () => () => {};
  const req = Object.assign(new EventEmitter(), { params: { competitionId: '999' }, query: { delta: '1' } });
  const res = response();
  res.set = () => res;
  res.flushHeaders = () => {};
  res.flush = () => {};
  try {
    await handler(req, res);
    await new Promise((r) => setImmediate(r));
    req.emit('close');
    res.emit('close');
    assert.equal(calls.filter((c) => c === 'closed').length, 1);
    const frames = calls.filter(Array.isArray);
    assert.equal(frames.length, 1);
    assert.equal(frames[0][0], frames[0][1]);
    assert.equal(JSON.parse(frames[0][0]).reset, true);
  } finally {
    req.emit('close');
    liveMetrics.begin = original.begin;
    live.liveFor = original.liveFor;
    live.subscribe = original.subscribe;
  }
});

test('pic global simultané, pas la somme des pics de formats distincts', () => {
  const f = fixture();
  const first = f.metrics.begin(response(), { delta: true });
  f.at(1000);
  first.close();
  const second = f.metrics.begin(response(), { delta: false });
  f.at(60000);
  f.metrics.flush();
  assert.equal(f.logs[0].connections_peak, 1);
  assert.equal(f.logs[0].connections_active, 1);
  assert.equal(f.logs[0].window_ms, 60000);
  second.close();
  f.metrics.stop();
});
