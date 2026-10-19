// Réimport d'une épreuve passée (Samsun, 24-25/09/2026, réimportée le 19/10) : les matchs reçoivent une heure
// d'enregistrement récente. Aucune alerte « résultat de mon tireur » pour un assaut tiré il y a plus d'un jour.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { playedRecently } = require('../src/services/pushNotifications');

test('alerte seulement pour un match ou une poule tiré dans les dernières 24 h', () => {
  const now = Date.parse('2026-10-19T21:00:00Z');
  assert.equal(playedRecently('2026-10-19T18:00:00Z', now), true);
  assert.equal(playedRecently('2026-09-25T08:00:00Z', now), false);
  assert.equal(playedRecently(null, now), true); // horaire inconnu : comportement inchangé
});

test('épreuve commencée il y a plus de 3 jours : plus d’alerte, même pour un match sans horaire', () => {
  const { eventIsCurrent } = require('../src/services/pushNotifications');
  const now = Date.parse('2026-10-19T21:00:00Z');
  assert.equal(eventIsCurrent(Date.parse('2026-10-18T08:00:00Z'), now), true); // J2 d'une épreuve de 2 jours
  assert.equal(eventIsCurrent(Date.parse('2026-09-25T07:00:00Z'), now), false); // Samsun réimportée
  assert.equal(eventIsCurrent(null, now), true); // début inconnu : comportement inchangé
});
