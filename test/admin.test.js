const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminMiddleware } = require('../src/middleware/admin');
test('administrator access uses current database role, fails closed, and ignores stale claims', async () => {
  let role = true,
    advanced = 0,
    status;
  const req = { user: { userId: 7, isAdmin: false } };
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  const admin = createAdminMiddleware({
    user: {
      findUnique: async ({ where }) => {
        assert.equal(where.id, 7);
        return role === null ? null : { isAdmin: role };
      },
    },
  });
  await admin(req, res, () => advanced++);
  assert.equal(advanced, 1);
  role = false;
  req.user.isAdmin = true;
  await admin(req, res, () => advanced++);
  assert.equal(status, 403);
  assert.equal(advanced, 1);
  role = null;
  await admin(req, res, () => advanced++);
  assert.equal(status, 403);
  assert.equal(advanced, 1);
  let error;
  const offline = createAdminMiddleware({
    user: {
      findUnique: async () => {
        throw new Error('offline');
      },
    },
  });
  await offline(req, res, (e) => {
    error = e;
  });
  assert.equal(error.message, 'offline');
});
test('every current administrator can pass the same guard; required 2FA is explained, not bypassed', async () => {
  const previous = process.env.REQUIRE_ADMIN_2FA;
  process.env.REQUIRE_ADMIN_2FA = 'true';
  try {
    let setup = false;
    const guard = createAdminMiddleware({
      user: {
        findUnique: async ({ where }) => ({
          isAdmin: [1, 6].includes(where.id),
          totpEnabledAt: setup ? new Date() : null,
        }),
      },
    });
    let payload,
      advanced = 0;
    const res = {
      status() {
        return this;
      },
      json(value) {
        payload = value;
      },
    };
    await guard({ user: { userId: 6 } }, res, () => advanced++);
    assert.equal(payload.twoFactorSetupRequired, true);
    assert.equal(advanced, 0);
    setup = true;
    for (const userId of [1, 6]) await guard({ user: { userId } }, res, () => advanced++);
    assert.equal(advanced, 2);
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_ADMIN_2FA;
    else process.env.REQUIRE_ADMIN_2FA = previous;
  }
});
