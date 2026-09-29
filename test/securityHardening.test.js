const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';

test('S1: a failed Resend call never exposes the API key, the recipient or the reset link', async () => {
  process.env.RESEND_API_KEY = 're_super_secret_key';
  process.env.MAIL_FROM = 'Pronos <no-reply@example.fr>';
  const { sendMail } = require('../src/services/mailer');
  const failing = {
    post: async (url, body, config) => {
      const e = new Error('Request failed with status code 429');
      Object.assign(e, {
        config: { ...config, data: JSON.stringify(body) },
        response: { status: 429 },
        code: 'ERR_BAD_REQUEST',
      });
      throw e;
    },
  };
  const err = await sendMail(
    { to: 'victim@example.fr', subject: 's', html: '?reset=SECRET-LINK', text: 't' },
    failing,
  ).catch((e) => e);
  const dump = require('node:util').inspect(err, { depth: 10 }) + JSON.stringify(err);
  assert.equal(err.providerStatus, 429);
  for (const secret of ['re_super_secret_key', 'victim@example.fr', 'SECRET-LINK'])
    assert.ok(!dump.includes(secret), secret);
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
});

test('S6/S8: tokens without session version are refused after the cutoff; sessions older than 90 days end', async () => {
  const users = [{ id: 5, isAdmin: false, sessionVersion: 0 }];
  require.cache[require.resolve('../src/lib/prisma')] = {
    exports: { user: { findUnique: async ({ where }) => users.find((u) => u.id === where.id) } },
  };
  delete require.cache[require.resolve('../src/middleware/auth')];
  const auth = require('../src/middleware/auth');
  const session = require('../src/services/session');
  const run = async (token, now = Date.now()) => {
    const realNow = Date.now;
    Date.now = () => now;
    try {
      let status = 200;
      await auth({ header: () => `Bearer ${token}` }, { status: (s) => ((status = s), { json: () => {} }) }, () => {});
      return status;
    } finally {
      Date.now = realNow;
    }
  };
  const secret = process.env.JWT_SECRET;
  const legacy = jwt.sign({ userId: 5, isAdmin: false }, secret, { expiresIn: '30d' });
  assert.equal(await run(legacy, Date.parse('2026-09-29T12:00:00Z')), 200, 'still accepted before the cutoff');
  assert.equal(await run(legacy, Date.parse('2026-09-30T00:00:01Z')), 401);
  assert.equal(await run(session.issueToken(users[0])), 200);
  const oldStart = Math.floor(Date.now() / 1000) - 91 * 24 * 3600;
  assert.equal(await run(session.issueToken(users[0], { since: oldStart })), 401, 'renewed forever: no');
  const refreshed = jwt.decode(session.issueToken(users[0], { since: session.sessionStart({ s0: 1234, iat: 99 }) }));
  assert.equal(refreshed.s0, 1234, 'refresh keeps the original sign-in time');
  assert.equal(session.sessionStart({ iat: 99 }), 99, 'older tokens start at their issue time');
});

test('S7: REQUIRE_ADMIN_2FA blocks admins without two-factor authentication', async () => {
  const { createAdminMiddleware } = require('../src/middleware/admin');
  const users = { 1: { isAdmin: true, totpEnabledAt: null }, 2: { isAdmin: true, totpEnabledAt: new Date() } };
  const mw = createAdminMiddleware({ user: { findUnique: async ({ where }) => users[where.id] } });
  const run = async (userId) => {
    let status = 200,
      body = null;
    await mw({ user: { userId } }, { status: (s) => ((status = s), { json: (b) => (body = b) }) }, () => {});
    return { status, body };
  };
  assert.equal((await run(1)).status, 200, 'off by default');
  process.env.REQUIRE_ADMIN_2FA = 'true';
  const blocked = await run(1);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.twoFactorSetupRequired, true);
  assert.equal((await run(2)).status, 200);
  delete process.env.REQUIRE_ADMIN_2FA;
});

test('S5: TOTP secrets survive the switch to a dedicated TOTP_ENC_KEY; short secrets are flagged', () => {
  const totp = require('../src/services/totp');
  const sealedWithLegacy = totp.sealSecret('JBSWY3DPEHPK3PXP');
  process.env.TOTP_ENC_KEY = 'a-dedicated-long-random-key-for-2fa-secrets';
  assert.equal(totp.openSecret(sealedWithLegacy), 'JBSWY3DPEHPK3PXP', 'legacy secrets stay readable');
  const sealedNew = totp.sealSecret('JBSWY3DPEHPK3PXP');
  process.env.JWT_SECRET = 'rotated-jwt-secret-value-for-the-test-only!!';
  assert.equal(totp.openSecret(sealedNew), 'JBSWY3DPEHPK3PXP', 'rotating JWT_SECRET no longer locks admins out');
  process.env.JWT_SECRET = 'local-test-secret-not-for-production';
  delete process.env.TOTP_ENC_KEY;
  const { configWarnings } = require('../src/config');
  assert.equal(configWarnings({ NODE_ENV: 'production', JWT_SECRET: 'short', TOTP_ENC_KEY: 'x' }).length, 1);
  assert.equal(configWarnings({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), TOTP_ENC_KEY: 'k' }).length, 0);
});

test('S3/S4: account deletion guesses are limited per account; login timing does not reveal unknown accounts', async (t) => {
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
  let compared = 0;
  const realCompare = bcrypt.compare;
  bcrypt.compare = async (...args) => (compared++, realCompare(...args));
  t.after(() => (bcrypt.compare = realCompare));
  require.cache[require.resolve('../src/lib/prisma')] = {
    exports: {
      user: {
        findUnique: async ({ where, select }) => {
          const u = find(where);
          return u && select ? Object.fromEntries(Object.keys(select).map((k) => [k, u[k]])) : u;
        },
        findFirst: async () => null,
        update: async ({ where, data }) => Object.assign(find(where), data),
      },
    },
  };
  for (const m of ['../src/routes/authRoutes', '../src/middleware/auth']) delete require.cache[require.resolve(m)];
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
      body: JSON.stringify(body),
    });
  compared = 0;
  assert.equal((await call('/login', 'POST', { email: 'ghost@example.fr', password: 'whatever-123' })).status, 400);
  assert.equal(compared, 1, 'a password comparison runs even for an unknown account');
  const login = await (
    await call('/login', 'POST', { email: 'alice@example.fr', password: 'alice-password-1' })
  ).json();
  assert.equal(bcrypt.getRounds(users[0].password), 12, 'old cost-4 hash upgraded to cost 12 after login');
  const statuses = [];
  for (let i = 0; i < 6; i++)
    statuses.push(
      (await call('/account', 'DELETE', { password: `wrong-${i}-password`, confirm: 'SUPPRIMER' }, login.token)).status,
    );
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
});
