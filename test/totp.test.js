const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';
const totp = require('../src/services/totp');

test('TOTP matches the RFC 6238 reference values (SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890');
  for (const [seconds, code] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])
    assert.equal(totp.hotp(secret, Math.floor(seconds / 30), 8), code);
  const b32 = totp.base32Encode(secret);
  assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(totp.base32Decode(b32), secret);
});

test('codes: clock drift of one step tolerated, replay refused, secret sealed at rest', () => {
  const secret = totp.generateSecret();
  const now = Date.parse('2026-09-28T18:00:10Z');
  const code = totp.hotp(totp.base32Decode(secret), totp.stepAt(now));
  const step = totp.verifyCode(secret, code, { now });
  assert.equal(step, totp.stepAt(now));
  assert.equal(totp.verifyCode(secret, code, { now: now + 30000 }), step, 'previous step still accepted');
  assert.equal(totp.verifyCode(secret, code, { now: now + 90000 }), null, 'too old');
  assert.equal(totp.verifyCode(secret, code, { now, lastStep: step }), null, 'a code cannot be reused');
  assert.equal(totp.verifyCode(secret, 'abcdef', { now }), null);
  const sealed = totp.sealSecret(secret);
  assert.ok(!sealed.includes(secret));
  assert.equal(totp.openSecret(sealed), secret);
  assert.match(
    totp.otpauthUrl(secret, 'admin@example.fr'),
    /^otpauth:\/\/totp\/Pronos%20Escrime%3Aadmin%40example\.fr\?secret=/,
  );
});

test('admin login requires the 6-digit code once 2FA is enabled; setup and disable flow', async (t) => {
  const users = [
    {
      id: 1,
      name: 'Admin',
      email: 'admin@example.fr',
      password: await bcrypt.hash('admin-password-1', 4),
      isAdmin: true,
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
    },
  ];
  const find = (where) => users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) || null;
  const db = {
    user: {
      findUnique: async ({ where }) => find(where),
      findFirst: async () => null,
      update: async ({ where, data }) => Object.assign(find(where), data),
      updateMany: async ({ where, data }) => {
        const u = find(where);
        const ok = u && (u.totpLastStep === null || u.totpLastStep < where.OR[1].totpLastStep.lt);
        if (ok) Object.assign(u, data);
        return { count: ok ? 1 : 0 };
      },
    },
    auditLog: { create: async () => ({}) },
  };
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
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
  const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
  const call = (path, body, auth = true) =>
    fetch(`http://127.0.0.1:${server.address().port}/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const codeFor = (secret, offset = 0) => totp.hotp(totp.base32Decode(secret), totp.stepAt() + offset);

  const setup = await (await call('/2fa/setup', {})).json();
  assert.ok(setup.secret && setup.otpauthUrl);
  assert.notEqual(users[0].totpSecret, setup.secret, 'stored sealed, not in clear');
  assert.equal(
    (await call('/login', { email: 'admin@example.fr', password: 'admin-password-1' }, false)).status,
    200,
    'not enforced before activation',
  );
  assert.equal((await call('/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await call('/2fa/enable', { code: codeFor(setup.secret) })).status, 200);

  const noCode = await call('/login', { email: 'admin@example.fr', password: 'admin-password-1' }, false);
  assert.equal(noCode.status, 401);
  assert.equal((await noCode.json()).twoFactorRequired, true);
  assert.equal(
    (
      await call(
        '/login',
        { email: 'admin@example.fr', password: 'admin-password-1', code: codeFor(setup.secret) },
        false,
      )
    ).status,
    400,
    'code already used for activation',
  );
  const ok = await call(
    '/login',
    { email: 'admin@example.fr', password: 'admin-password-1', code: codeFor(setup.secret, 1) },
    false,
  );
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
  assert.equal(
    (
      await call(
        '/login',
        { email: 'admin@example.fr', password: 'wrong-password', code: codeFor(setup.secret, 1) },
        false,
      )
    ).status,
    400,
  );

  assert.equal((await call('/2fa/disable', { password: 'admin-password-1', code: '123456' })).status, 400);
  users[0].totpLastStep = null;
  assert.equal((await call('/2fa/disable', { password: 'admin-password-1', code: codeFor(setup.secret) })).status, 200);
  assert.equal(users[0].totpEnabledAt, null);
});
