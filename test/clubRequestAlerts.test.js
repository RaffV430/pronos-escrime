const test = require('node:test');
const assert = require('node:assert/strict');
const { alertAdmins } = require('../src/services/clubRequestMail');
function fixture(row) {
  const updates = [];
  const expired = [];
  const db = {
    $queryRaw: async () => [],
    clubRegistrationRequest: {
      updateMany: async (value) => {
        expired.push(value);
        return { count: 0 };
      },
      findFirst: async ({ where }) => {
        assert.equal(where.status, 'PENDING');
        return row;
      },
      update: async (value) => {
        updates.push(value.data);
      },
    },
  };
  db.$transaction = (fn) => fn(db);
  return { db, updates, expired };
}
test('pending requests alert administrators and mark successful delivery', async () => {
  const { db, updates } = fixture({ id: 9, adminAlertAttempts: 0 });
  const result = await alertAdmins(db, async (_, message) => {
    assert.equal(message.url, '/admin?panel=clubs&request=9');
    assert.equal(message.tag, 'club-request-9');
    return { mail: 1, push: 1, mailFailed: 0, pushFailed: 0 };
  });
  assert.equal(result, 1);
  assert.equal(updates[0].adminAlertStatus, 'SENDING');
  assert.equal(updates[1].adminAlertStatus, 'SENT');
});
test('failed channels retry and never label the alert delivered', async () => {
  const { db, updates } = fixture({ id: 9, adminAlertAttempts: 0 });
  assert.equal(await alertAdmins(db, async () => ({ mail: 0, mailFailed: 1 })), 0);
  assert.equal(updates[1].adminAlertStatus, 'PENDING');
});
test('fifth failed attempt stops retries; no pending request sends nothing', async () => {
  const { db, updates } = fixture({ id: 9, adminAlertAttempts: 4 });
  await alertAdmins(db, async () => {
    throw new Error('provider offline');
  });
  assert.equal(updates[1].adminAlertStatus, 'FAILED');
  const empty = fixture(null);
  assert.equal(await alertAdmins(empty.db, async () => assert.fail('must not send')), 0);
});

test('expired final lease is marked failed after a worker restart', async () => {
  const { db, expired } = fixture(null);
  const now = new Date('2026-10-09T12:00:00Z');
  await alertAdmins(db, async () => assert.fail('must not send'), now);
  assert.deepEqual(expired[0], {
    where: {
      status: 'PENDING',
      adminAlertStatus: 'SENDING',
      adminAlertNextAt: { lte: now },
      adminAlertAttempts: { gte: 5 },
    },
    data: { adminAlertStatus: 'FAILED' },
  });
});
test('no configured recipient does not falsely mark alert sent', async () => {
  const { db, updates } = fixture({ id: 9, adminAlertAttempts: 0 });
  await alertAdmins(db, async () => ({ mail: 0, push: 0, mailFailed: 0, pushFailed: 0 }));
  assert.equal(updates[1].adminAlertStatus, 'PENDING');
});

test('mail alone or push alone keeps the other channel pending', async () => {
  for (const result of [
    { mail: 1, push: 0 },
    { mail: 0, push: 1 },
  ]) {
    const { db, updates } = fixture({ id: 9, adminAlertAttempts: 0 });
    assert.equal(await alertAdmins(db, async () => result), 0);
    assert.equal(updates[1].adminAlertStatus, 'PENDING');
  }
});
test('administrator delivery targets every admin and every enabled admin subscription', async () => {
  const emails = [],
    subscriptions = [];
  const admins = [
    { id: 1, email: 'one@example.test' },
    { id: 2, email: 'two@example.test' },
    { id: 3, email: 'three@example.test' },
  ];
  const db = {
    user: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { isAdmin: true });
        return admins;
      },
    },
    pushSubscription: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { enabled: true, userId: { in: [1, 2, 3] } });
        return [{ id: 11 }, { id: 22 }, { id: 33 }, { id: 34 }];
      },
    },
  };
  const result = await require('../src/services/syncHealth').notifyAdmins(
    db,
    {
      title: 'Club à valider',
      body: '<Demande en attente>',
      tag: 'club-request-1',
      url: '/admin?panel=clubs&request=1',
    },
    {
      mailer: {
        mailConfigured: () => true,
        sendMail: async ({ to, html, text }) => {
          assert.match(html, /&#60;Demande en attente&#62;/);
          assert.match(text, /admin\?panel=clubs&request=1/);
          emails.push(to);
        },
      },
      push: {
        configured: () => true,
        send: async (sub, payload) => {
          assert.equal(payload.url, '/admin?panel=clubs&request=1');
          assert.equal(payload.adminAlert, true);
          subscriptions.push(sub.id);
        },
      },
    },
  );
  assert.deepEqual(
    emails,
    admins.map((a) => a.email),
  );
  assert.deepEqual(subscriptions, [11, 22, 33, 34]);
  assert.equal(result.mail, 3);
  assert.equal(result.push, 4);
});
