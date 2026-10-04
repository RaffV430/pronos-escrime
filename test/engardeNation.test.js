// Épreuve internationale (Circuit Antony, fleuret dames) : aux tours suivants, engarde écrit
// « NOM Prénom NAT » dans la colonne des qualifiés.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/services/engardeParser');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'engarde', 'fdm20-tableau16.html'), 'utf8');
// Nation accolée au nom dans toutes les colonnes de qualifiés (pas dans la colonne d'entrée).
const international = html.replace(
  /(<td class="HBD fencer quarter\d">)([^<]+)(<\/td>)(?!<td class="HBD nation)/g,
  (m, a, name, b) => `${a}${name.trim()} FRA ${b}`,
);

test('engarde : nation accolée au nom des qualifiés, vainqueurs et tours suivants reconnus', () => {
  assert.notEqual(international, html);
  const plain = E.parseTableaus([html]);
  const intl = E.parseTableaus([international]);
  assert.deepEqual(
    intl.matches.map((m) => [m.sourceKey, m.player1, m.player2, m.winner, m.score1, m.score2]),
    plain.matches.map((m) => [m.sourceKey, m.player1, m.player2, m.winner, m.score1, m.score2]),
  );
  assert.equal(intl.matches.find((m) => m.round === 'T2').player1, 'BOLORE Mélisande');
});

test('engarde : « DNF » à la place du score = qualifié sur abandon', () => {
  const dnf = html.replace('<td class="D score">15/10</td>', '<td class="D score">DNF</td>');
  assert.notEqual(dnf, html);
  const m = E.parseTableaus([dnf]).matches.find((x) => x.round === 'T8' && x.sourceKey === 'T8:1');
  assert.deepEqual(
    [m.winner, m.isFinished, m.resultType, m.score1, m.score2],
    [1, true, 'MEDICAL_WITHDRAWAL', null, null],
  );
});
