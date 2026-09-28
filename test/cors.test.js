const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originAllowed } = require('../src/config');

test('CORS: exact origins, and a wildcard limited to one label for Vercel previews', () => {
  const allowed = ['https://pronos-escrime.vercel.app', 'https://pronos-escrime-*.vercel.app'];
  assert.equal(originAllowed('https://pronos-escrime.vercel.app', allowed), true);
  assert.equal(originAllowed('https://pronos-escrime-git-feat-x-raffv430s-projects.vercel.app', allowed), true);
  assert.equal(originAllowed('https://pronos-escrime-abc123.vercel.app', allowed), true);
  assert.equal(originAllowed('https://pronos-escrime-x.evil.com/.vercel.app', allowed), false);
  assert.equal(originAllowed('https://evil.com?https://pronos-escrime-a.vercel.app', allowed), false);
  assert.equal(originAllowed('https://pronos-escrime-a.b.vercel.app', allowed), false, 'no extra dots');
  assert.equal(originAllowed('http://pronos-escrime-a.vercel.app', allowed), false, 'https only');
  assert.equal(originAllowed('https://pronos-escrimeXvercel.app', ['https://pronos-escrime.vercel.app']), false);
});
