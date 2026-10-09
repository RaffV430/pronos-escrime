const test = require('node:test');
const assert = require('node:assert/strict');
const { supportMessage } = require('../src/services/supportMessage');
test('support fixes destination and reply address to account, preserves description', () => {
  const result = supportMessage(
    {
      subject: 'Erreur poules',
      message: 'Mon tableau ne se charge pas.',
      to: 'other@example.com',
      replyTo: 'other@example.com',
    },
    { name: 'Test', email: 'test@example.com' },
  );
  assert.equal(result.to, 'support@pronos-escrime.fr');
  assert.equal(result.replyTo, 'test@example.com');
  assert.match(result.text, /Mon tableau ne se charge pas/);
});
test('support rejects invalid and oversized submissions', () => {
  for (const body of [
    {},
    { subject: 'A', message: 'Description complète' },
    { subject: 'Objet\nInjecté', message: 'Description complète' },
    { subject: 'Objet', message: 'x'.repeat(5001) },
  ])
    assert.throws(() => supportMessage(body, {}), { status: 400 });
});
