const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validPassword } = require('../src/services/passwordPolicy');
const { rateIdentity } = require('../src/middleware/rateIdentity');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-audit-test-secret-at-least-32-characters';

test('password policy checks bcrypt byte limit, including Unicode', () => {
  assert.equal(validPassword('a'.repeat(72)), true);
  assert.equal(validPassword('a'.repeat(73)), false);
  assert.equal(validPassword('é'.repeat(36)), true);
  assert.equal(validPassword('é'.repeat(37)), false);
});
test('rotating invalid tokens cannot rotate the IP quota; signed sessions share a user quota', () => {
  const req = (token) => ({ ip: '127.0.0.1', headers: { authorization: `Bearer ${token}` } });
  assert.equal(rateIdentity(req('invalid-1')), rateIdentity(req('invalid-2')));
  const token = (sv) => jwt.sign({ userId: 7, sv }, process.env.JWT_SECRET);
  assert.equal(rateIdentity(req(token(1))), rateIdentity(req(token(2))));
  assert.equal(rateIdentity(req(token(1))), 'user:7');
  assert.equal(
    rateIdentity(req(jwt.sign({ userId: 7, sv: 0, purpose: 'reset' }, process.env.JWT_SECRET))),
    rateIdentity(req('invalid')),
  );
});
