const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTerms, prohibited } = require('../src/services/clubModeration');
test('club moderation matches entire accent-insensitive words and phrases, not legitimate substrings', () => {
  const terms = validateTerms([' INTERDIT ', 'interdît', 'mot interdit']);
  assert.deepEqual(terms, ['interdit', 'mot interdit']);
  assert.equal(prohibited({ name: 'Club interdît' }, terms), true);
  assert.equal(prohibited({ name: 'Club', city: 'mot-interdit' }, terms), true);
  assert.equal(prohibited({ name: 'Club', shortName: 'INTERDIT' }, terms), true);
  assert.equal(prohibited({ name: 'Interdiction escrime' }, terms), false);
  assert.equal(prohibited({ name: 'Club normal' }, []), false);
  assert.throws(() => validateTerms('bad'), { status: 400 });
  assert.throws(() => validateTerms(['!!!']), { status: 400 });
  assert.throws(() => validateTerms(Array(2001).fill('mot')), { status: 400 });
});
