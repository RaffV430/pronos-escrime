const test = require('node:test');
const assert = require('node:assert/strict');
const { assertGoogleSheetUrl, parseSheetRecords } = require('../src/services/sheetSync');

test('accepte uniquement une URL Google Sheets HTTPS', () => {
  assert.match(assertGoogleSheetUrl('https://docs.google.com/spreadsheets/d/test/export?format=csv'), /^https:/);
  assert.throws(() => assertGoogleSheetUrl('http://docs.google.com/test'));
  assert.throws(() => assertGoogleSheetUrl('https://example.com/test.csv'));
});

test('convertit une ligne CSV complète en match terminé', () => {
  const [match] = parseSheetRecords('ID,Tireur1,Tireur2,Score1,Score2\n12,Alice,Bob,15,9\n', 3);
  assert.deepEqual(match, {
    id: 30012,
    competitionId: 3,
    player1: 'Alice',
    player2: 'Bob',
    score1: 15,
    score2: 9,
    isFinished: true,
  });
});

test('refuse les scores partiels et les identifiants dupliqués', () => {
  assert.throws(() => parseSheetRecords('ID,Tireur1,Tireur2,Score1,Score2\n1,A,B,15,\n', 1));
  assert.throws(() => parseSheetRecords('ID,Tireur1,Tireur2,Score1,Score2\n1,A,B,,\n1,C,D,,\n', 1));
});
