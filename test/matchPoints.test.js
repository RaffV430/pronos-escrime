const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateMatchPoints } = require('../src/services/matchPoints');

test('attribue 4 points pour le vainqueur et le score exacts', () => {
  assert.equal(calculateMatchPoints(15, 12, 15, 12), 4);
});

test('attribue 1 point pour le bon vainqueur sans score exact', () => {
  assert.equal(calculateMatchPoints(15, 10, 15, 12), 1);
});

test('attribue 0 point pour le mauvais vainqueur ou une égalité', () => {
  assert.equal(calculateMatchPoints(12, 15, 15, 12), 0);
  assert.equal(calculateMatchPoints(10, 10, 15, 12), 0);
});

test('medical withdrawal awards winner only, including corrected winner and draws', () => {
  assert.equal(calculateMatchPoints(15, 0, null, null, 1, 'MEDICAL_WITHDRAWAL'), 1);
  assert.equal(calculateMatchPoints(15, 0, null, null, 2, 'MEDICAL_WITHDRAWAL'), 0);
  assert.equal(calculateMatchPoints(0, 15, null, null, 2, 'MEDICAL_WITHDRAWAL'), 1);
  assert.equal(calculateMatchPoints(0, 0, null, null, 1, 'MEDICAL_WITHDRAWAL'), 0);
  assert.equal(calculateMatchPoints(15, 0, null, null), 0);
});
