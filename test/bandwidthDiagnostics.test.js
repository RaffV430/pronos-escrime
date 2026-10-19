const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const compression = require('compression');
const { bandwidthDiagnostics } = require('../src/lib/bandwidthDiagnostics');
test('diagnostic : compte le corps compressé, jamais identifiants, paramètres ni contenu', async () => {
  const logs = [];
  const diagnostic = bandwidthDiagnostics({
    log: (line) => logs.push(JSON.parse(line)),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  const app = express();
  app.use(diagnostic.middleware);
  app.use(compression({ threshold: 1024 }));
  const router = express.Router();
  router.get('/:id', (_req, res) => res.json({ synthetic: 'x'.repeat(10000) }));
  app.use('/api/matches', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    let bytes = 0;
    await new Promise((resolve, reject) => {
      http
        .get(
          `http://127.0.0.1:${server.address().port}/api/matches/99001?private=never-log`,
          { headers: { 'Accept-Encoding': 'gzip' } },
          (res) => {
            assert.equal(res.headers['content-encoding'], 'gzip');
            res.on('data', (chunk) => {
              bytes += chunk.length;
            });
            res.on('end', resolve);
          },
        )
        .on('error', reject);
    });
    diagnostic.flush();
    assert.deepEqual(logs, [
      { event: 'http_body_bytes', routes: [{ method: 'GET', route: '/api/matches/:id', bytes }] },
    ]);
    assert.ok(bytes < 1000);
    assert.ok(!JSON.stringify(logs).includes('99001'));
    assert.ok(!JSON.stringify(logs).includes('never-log'));
    diagnostic.flush();
    assert.equal(logs.length, 1);
  } finally {
    diagnostic.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
