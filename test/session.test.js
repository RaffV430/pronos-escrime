const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';

test('30-day sessions: refresh, password change and "log out other devices" revoke older tokens', async (t) => {
  const users = [
    {
      id: 5,
      name: 'Alice',
      email: 'alice@example.fr',
      password: await bcrypt.hash('alice-password-1', 4),
      isAdmin: false,
      sessionVersion: 0,
    },
  ];
  const find = (w) => users.find((u) => (w.id ? u.id === w.id : u.email === w.email)) || null;
  const db = {
    user: {
      findUnique: async ({ where, select }) => {
        const u = find(where);
        return u && select ? Object.fromEntries(Object.keys(select).map((k) => [k, u[k]])) : u;
      },
      findFirst: async () => null,
      update: async ({ where, data }) => {
        const u = find(where);
        for (const [k, v] of Object.entries(data)) u[k] = v?.increment ? u[k] + v.increment : v;
        return u;
      },
    },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  const session = require('../src/services/session');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/authRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const call = (path, method, body, token) =>
    fetch(`http://127.0.0.1:${server.address().port}/auth${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  const login = await (
    await call('/login', 'POST', { email: 'alice@example.fr', password: 'alice-password-1' })
  ).json();
  const claims = jwt.decode(login.token);
  assert.equal(claims.sv, 0);
  assert.equal(claims.exp - claims.iat, 30 * 24 * 3600, 'valid 30 days');
  assert.equal((await call('/me', 'GET', undefined, login.token)).status, 200);

  const refreshed = await (await call('/refresh', 'POST', {}, login.token)).json();
  assert.ok(refreshed.token);

  // A second device logs in, then the first changes the password.
  const other = (
    await (await call('/login', 'POST', { email: 'alice@example.fr', password: 'alice-password-1' })).json()
  ).token;
  assert.equal(
    (
      await call(
        '/change-password',
        'POST',
        { currentPassword: 'wrong-pass-00', newPassword: 'new-password-123' },
        login.token,
      )
    ).status,
    400,
  );
  const changed = await (
    await call(
      '/change-password',
      'POST',
      { currentPassword: 'alice-password-1', newPassword: 'new-password-123' },
      login.token,
    )
  ).json();
  assert.equal((await call('/me', 'GET', undefined, other)).status, 401, 'other device logged out at once');
  assert.equal((await call('/me', 'GET', undefined, login.token)).status, 401, 'old token of this device refused');
  assert.equal(
    (await call('/me', 'GET', undefined, changed.token)).status,
    200,
    'new token keeps this device signed in',
  );

  const again = (
    await (await call('/login', 'POST', { email: 'alice@example.fr', password: 'new-password-123' })).json()
  ).token;
  const kept = (await (await call('/logout-others', 'POST', {}, changed.token)).json()).token;
  assert.equal((await call('/me', 'GET', undefined, again)).status, 401);
  assert.equal((await call('/me', 'GET', undefined, kept)).status, 200);

  users.splice(0, 1);
  session.forget(5);
  assert.equal((await call('/me', 'GET', undefined, kept)).status, 401, 'deleted account');
  const legacy = jwt.sign({ userId: 9, isAdmin: false }, process.env.JWT_SECRET, { expiresIn: '24h' });
  assert.notEqual(
    (await call('/refresh', 'POST', {}, legacy)).status,
    403,
    'pre-existing 24h tokens still accepted until they expire',
  );
});
