const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refusalMessage } = require('../src/services/clubRequestEmail');
test('separate requests have distinct subjects, readable refusal and account links', () => {
  const row = { id: 6, name: 'Club exemple', city: 'Paris', reason: 'Nom non conforme.' };
  const a = refusalMessage(row),
    b = refusalMessage({ ...row, id: 7 });
  assert.notEqual(a.subject, b.subject);
  assert.match(a.text, /Demande n° 6/);
  assert.match(a.html, /Motif du refus/);
  assert.match(a.html, /href="https?:[^"]+\/compte"/);
  assert.match(a.text, /Nom non conforme/);
  assert.match(a.text, /vos pronostics restent accessibles/);
});
test('club and administrator text cannot inject markup or subject headers', () => {
  const mail = refusalMessage({ id: 8, name: '<script>\r\nBcc: bad', city: '<Paris>', reason: '<img src=x> & refus' });
  assert.doesNotMatch(mail.subject, /[\r\n]/);
  assert.doesNotMatch(mail.html, /<script>|<img src=x>/);
  assert.match(mail.html, /&lt;img src=x&gt; &amp; refus/);
  assert.match(mail.text, /<img src=x> & refus/);
});
