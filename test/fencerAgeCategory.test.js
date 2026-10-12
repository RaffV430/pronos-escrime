const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ageCategory, verifiedCategory } = require('../src/services/fencerAgeCategory');
test('catégorie de saison, indépendante du surclassement et bascule en septembre', () => {
  assert.equal(ageCategory(2009, new Date('2026-08-31T12:00:00Z')), 'M17');
  assert.equal(ageCategory(2009, new Date('2026-09-01T12:00:00Z')), 'M20');
  assert.equal(ageCategory(2010, new Date('2026-10-12T12:00:00Z')), 'M17');
  assert.equal(ageCategory(1987, new Date('2026-10-12T12:00:00Z')), 'V1');
  assert.equal(ageCategory(null), null);
  assert.equal(verifiedCategory({ name: 'Inconnu', country: 'FRA', federationVerified: true }), null);
  assert.equal(verifiedCategory({ name: 'ROBINET Lucas', country: 'FRA', federationVerified: false }), null);
});
