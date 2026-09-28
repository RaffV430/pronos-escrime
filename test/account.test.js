const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret-not-for-production';
process.env.RESEND_API_KEY = 're_test';
process.env.MAIL_FROM = 'Pronos <noreply@example.fr>';
process.env.APP_URL = 'https://app.example.fr';
const account = require('../src/services/account');

function fixture() {
  const users = [];
  const leagues = [
    { id: 1, ownerId: 2, name: 'Amis' },
    { id: 2, ownerId: 2, name: 'Solo' },
  ];
  const members = [
    { leagueId: 1, userId: 2, joinedAt: new Date(1) },
    { leagueId: 1, userId: 5, joinedAt: new Date(3) },
    { leagueId: 1, userId: 4, joinedAt: new Date(2) },
    { leagueId: 2, userId: 2, joinedAt: new Date(1) },
  ];
  let picks = [{ userId: 2 }, { userId: 4 }];
  const db = {
    user: {
      findUnique: async ({ where }) =>
        users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) || null,
      findFirst: async () => null,
      update: async ({ where, data }) =>
        Object.assign(
          users.find((u) => u.id === where.id),
          data,
        ),
      delete: async ({ where }) =>
        users.splice(
          users.findIndex((u) => u.id === where.id),
          1,
        ),
    },
    challengePick: { deleteMany: async ({ where }) => (picks = picks.filter((p) => p.userId !== where.userId)) },
    leagueMember: {
      deleteMany: async ({ where }) => {
        for (let i = members.length - 1; i >= 0; i--) if (members[i].userId === where.userId) members.splice(i, 1);
      },
      findFirst: async ({ where }) =>
        members.filter((m) => m.leagueId === where.leagueId).sort((a, b) => a.joinedAt - b.joinedAt)[0] || null,
    },
    league: {
      findMany: async ({ where }) => leagues.filter((l) => l.ownerId === where.ownerId),
      update: async ({ where, data }) =>
        Object.assign(
          leagues.find((l) => l.id === where.id),
          data,
        ),
      delete: async ({ where }) =>
        leagues.splice(
          leagues.findIndex((l) => l.id === where.id),
          1,
        ),
    },
  };
  db.$transaction = (fn) => fn(db);
  return {
    db,
    users,
    leagues,
    members,
    get picks() {
      return picks;
    },
  };
}

async function server(t, db, mails) {
  require.cache[require.resolve('../src/lib/prisma')] = { exports: db };
  require.cache[require.resolve('axios')] = { exports: { post: async (url, body) => mails.push({ url, body }) } };
  for (const m of ['../src/services/mailer', '../src/routes/authRoutes']) delete require.cache[require.resolve(m)];
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/authRoutes'));
  app.use('/me', require('../src/routes/personalRoutes'));
  const s = app.listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return (path, method = 'POST', body, token) =>
    fetch(`http://127.0.0.1:${s.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test('password reset: generic answer, e-mailed single-use link, new password works', async (t) => {
  const f = fixture();
  f.users.push({ id: 2, name: 'Alice', email: 'alice@example.fr', password: await bcrypt.hash('old-password-1', 4) });
  const mails = [];
  const call = await server(t, f.db, mails);
  const unknown = await call('/auth/forgot-password', 'POST', { email: 'nobody@example.fr' });
  const known = await call('/auth/forgot-password', 'POST', { email: 'Alice@Example.fr' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), await known.json(), 'same answer whether the account exists or not');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(mails[0].body.to, ['alice@example.fr']);
  const token = decodeURIComponent(mails[0].body.text.match(/\?reset=(\S+)/)[1]);
  assert.match(mails[0].body.text, /^[\s\S]*https:\/\/app\.example\.fr\/\?reset=/);

  assert.equal((await call('/auth/me', 'GET', undefined, token)).status, 401, 'a reset link is not a session');
  assert.equal((await call('/me/season', 'GET', undefined, token)).status, 401);
  assert.equal((await call('/auth/reset-password', 'POST', { token, password: 'short' })).status, 400);
  assert.equal((await call('/auth/reset-password', 'POST', { token, password: 'new-password-123' })).status, 200);
  assert.ok(await bcrypt.compare('new-password-123', f.users[0].password));
  assert.equal(
    (await call('/auth/reset-password', 'POST', { token, password: 'another-pass-123' })).status,
    400,
    'the link cannot be reused',
  );
  const expired = jwt.sign(
    { sub: 2, purpose: 'password-reset', stamp: account.passwordStamp(f.users[0].password) },
    process.env.JWT_SECRET,
    { expiresIn: -10 },
  );
  assert.equal(
    (await call('/auth/reset-password', 'POST', { token: expired, password: 'another-pass-123' })).status,
    400,
  );
  const session = jwt.sign({ userId: 2 }, process.env.JWT_SECRET);
  assert.equal(
    (await call('/auth/reset-password', 'POST', { token: session, password: 'another-pass-123' })).status,
    400,
    'a session token is not a reset link',
  );
});

test('account deletion requires the password and cleans leagues and challenge picks', async (t) => {
  const f = fixture();
  f.users.push(
    {
      id: 2,
      name: 'Alice',
      email: 'alice@example.fr',
      password: await bcrypt.hash('alice-password', 4),
      isAdmin: false,
    },
    {
      id: 9,
      name: 'Admin',
      email: 'admin@example.fr',
      password: await bcrypt.hash('admin-password', 4),
      isAdmin: true,
    },
  );
  const call = await server(t, f.db, []);
  const token = jwt.sign({ userId: 2 }, process.env.JWT_SECRET);
  assert.equal(
    (await call('/auth/account', 'DELETE', { password: 'alice-password' }, token)).status,
    400,
    'typed confirmation required',
  );
  assert.equal((await call('/auth/account', 'DELETE', { password: 'wrong', confirm: 'SUPPRIMER' }, token)).status, 400);
  assert.equal(
    (
      await call(
        '/auth/account',
        'DELETE',
        { password: 'admin-password', confirm: 'SUPPRIMER' },
        jwt.sign({ userId: 9 }, process.env.JWT_SECRET),
      )
    ).status,
    409,
    'admins cannot delete themselves here',
  );
  assert.equal(
    (await call('/auth/account', 'DELETE', { password: 'alice-password', confirm: 'SUPPRIMER' }, token)).status,
    200,
  );
  assert.deepEqual(
    f.users.map((u) => u.id),
    [9],
  );
  assert.deepEqual(f.picks, [{ userId: 4 }]);
  assert.deepEqual(
    f.leagues,
    [{ id: 1, ownerId: 4, name: 'Amis' }],
    'shared league goes to the oldest member, empty league removed',
  );
});
