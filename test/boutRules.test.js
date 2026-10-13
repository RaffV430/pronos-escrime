const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boutMax, isVeteranEvent } = require('../src/lib/boutRules');

test('épreuves vétérans en 10 touches, seniors et jeunes en 15, équipes en 45', () => {
  assert.equal(boutMax({ name: "Vet-50 Men's Foil" }), 10);
  assert.equal(boutMax({ name: 'Championnat de France Vétérans' }), 10);
  assert.equal(boutMax({ name: "Senior Men's Foil" }), 15);
  assert.equal(boutMax({ name: "Cadet Women's Foil" }), 15);
  assert.equal(boutMax({ name: "Grand Vet Team Men's Épée", podiumFormat: 'TEAM' }), 45);
  // Seule la mention de l'épreuve compte, pas l'âge des tireurs.
  assert.equal(isVeteranEvent({ name: 'Épreuve nationale 1' }), false);
});
