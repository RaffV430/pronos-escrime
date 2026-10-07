const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'local-http-safety-secret-at-least-32-characters';
process.env.DATABASE_URL ||= 'postgresql://local:local@127.0.0.1:59999/test';
const { app } = require('../src/server');
test('invalid JSON is 400 and oversized input is 413; neither body reaches error logs', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const errors = [],
    original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [body, status] of [
      ['{"password":"DO-NOT-LOG",', 400],
      [JSON.stringify({ password: 'x'.repeat(110000) }), 413],
    ]) {
      const response = await fetch(base + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, status);
    }
    assert.deepEqual(errors, []);
  } finally {
    console.error = original;
    await new Promise((resolve) => server.close(resolve));
  }
});
