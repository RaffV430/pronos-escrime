const { test } = require('node:test');
const assert = require('node:assert/strict');
test('page publique : pseudonymes abrégés, jamais de nom complet', () => {
  const { publicName } = require('../src/services/eventResults');
  assert.equal(publicName('Raffaele Venturi'), 'Raffaele V.');
  assert.equal(publicName('Raff'), 'Raff');
  assert.equal(publicName('  '), 'Joueur');
  assert.equal(publicName('jean de la fontaine'), 'jean D.');
});
