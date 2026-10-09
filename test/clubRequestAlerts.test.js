const test = require('node:test');
const assert = require('node:assert/strict');
const { alertAdmins } = require('../src/services/clubRequestMail');
function fixture(row) {
  const updates = [];
  const db = {
    $queryRaw: async () => [],
    clubRegistrationRequest: {
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
  return { db, updates };
}
test('pending requests alert administrators and mark successful delivery', async () => {
  const { db, updates } = fixture({ id: 9, adminAlertAttempts: 0 });
  const result = await alertAdmins(db, async (_, message) => {
    assert.equal(message.url, '/admin');
    assert.equal(message.tag, 'club-request-9');
    return { mail: 1, mailFailed: 0, pushFailed: 0 };
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
