const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const compression = require('compression');
const { preserveSseEncoding } = require('../src/middleware/preserveSseEncoding');
const { measure } = require('../scripts/measureLiveBandwidth.cjs');

test('SSE : no-transform ajouté après compression, négociation gzip/br/identity respectée, JSON inchangé', async () => {
  const app = express();
  app.use(preserveSseEncoding);
  app.use(compression({ threshold: 1024 }));
  app.get('/sse', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store' });
    res.flushHeaders();
    res.write('data: []\n\n');
    res.flush();
    res.end();
  });
  app.get('/json', (_req, res) => res.json({ synthetic: 'x'.repeat(4000) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const [accept, expected] of [
      ['gzip', 'gzip'],
      ['br, gzip', 'br'],
      ['identity', 'identity'],
      ['gzip;q=0, br;q=0', 'identity'],
    ]) {
      const response = await new Promise((resolve, reject) => {
        http
          .get(
            {
              host: '127.0.0.1',
              port: server.address().port,
              path: '/sse?transport=diagnostic',
              headers: { 'Accept-Encoding': accept },
            },
            (res) => {
              const chunks = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            },
          )
          .on('error', reject);
      });
      assert.equal(response.headers['content-encoding'] || 'identity', expected);
      assert.equal(response.headers['x-live-origin-encoding'], expected);
      assert.equal(response.headers['x-live-request-encoding'], 'present');
      assert.equal(response.headers['cache-control'], 'no-cache, no-store, no-transform');
      const decode = expected === 'gzip' ? zlib.gunzipSync : expected === 'br' ? zlib.brotliDecompressSync : (x) => x;
      assert.equal(decode(response.body).toString(), 'data: []\n\n');
    }
    await new Promise((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: server.address().port, path: '/json', headers: { 'Accept-Encoding': 'gzip' } },
          (res) => {
            assert.equal(res.headers['content-encoding'], 'gzip');
            assert.ok(!String(res.headers['cache-control']).includes('no-transform'));
            res.resume();
            res.on('end', resolve);
          },
        )
        .on('error', reject);
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Relais de test : conserver le corps gzip réduit les octets reçus, sans altérer scores et corrections', async () => {
  for (const delta of [false, true]) {
    const before = await measure({ delta, gzip: true, transformProxy: true });
    const after = await measure({ delta, gzip: true, transformProxy: true, preserveEncoding: true });
    assert.equal(after.frames, before.frames);
    assert.ok(after.bytes < before.bytes / 2);
    assert.equal(after.bytes, after.upstreamBytes);
    assert.equal(before.upstreamBytes, after.upstreamBytes);
  }
});
