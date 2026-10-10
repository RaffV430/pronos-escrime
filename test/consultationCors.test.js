const test = require('node:test');
const assert = require('node:assert/strict');
const cors = require('cors');
const options = require('../src/middleware/consultationCors');
test('conditional consultation headers are allowed and ETag is visible', () => {
  const headers = {};
  const response = {
    getHeader: (name) => headers[name],
    setHeader: (name, value) => {
      headers[name] = value;
    },
    end() {},
  };
  cors({ origin: 'https://www.pronos-escrime.fr', ...options })(
    {
      method: 'OPTIONS',
      headers: {
        origin: 'https://www.pronos-escrime.fr',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,if-none-match',
      },
    },
    response,
    () => {},
  );
  assert.ok(headers['Access-Control-Allow-Headers'].includes('If-None-Match'));
  cors({ origin: 'https://www.pronos-escrime.fr', ...options })(
    { method: 'GET', headers: { origin: 'https://www.pronos-escrime.fr' } },
    response,
    () => {},
  );
  assert.equal(headers['Access-Control-Expose-Headers'], 'ETag');
});

test('unchanged JSON returns no body but still checks authorization', async (t) => {
  const express = require('express');
  const app = express();
  app.use(cors({ origin: 'https://www.pronos-escrime.fr', ...options }));
  app.get('/matches', (req, res) => {
    if (req.headers.authorization !== 'Bearer test') return res.status(401).json({ error: 'unauthorized' });
    return res.json([{ id: 735, isFinished: true }]);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/matches`;
  const first = await fetch(url, { headers: { Authorization: 'Bearer test' } });
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.text();
  const unchanged = await fetch(url, {
    headers: { Authorization: 'Bearer test', 'If-None-Match': etag, 'Cache-Control': 'max-age=0' },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  const unauthorized = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(unauthorized.status, 401);
});
