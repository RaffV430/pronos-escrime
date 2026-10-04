// Épreuve sur plusieurs jours : engarde n'affiche que l'heure ; une phase qui commence plus tôt que la
// précédente se joue le lendemain.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextDay, dayOf, startsAt } = require('../src/services/engardeSync');

test('passage au lendemain quand une phase commence plus tôt que la précédente', () => {
  let d = nextDay(null, 9 * 60); // poules samedi 9 h
  assert.deepEqual(d, { min: 540, offset: 0 });
  d = nextDay(d, 13 * 60 + 15); // T256 samedi 13 h 15
  assert.equal(d.offset, 0);
  d = nextDay(d, 14 * 60 + 30); // T128 samedi
  assert.equal(d.offset, 0);
  d = nextDay(d, 9 * 60); // T32 dimanche 9 h
  assert.equal(d.offset, 1);
  d = nextDay(d, null); // tour sans horaire : même jour que le précédent
  assert.equal(d.offset, 1);
  d = nextDay(d, 11 * 60); // finale dimanche 11 h
  assert.equal(d.offset, 1);
});

test('date et heure locales du jour décalé', () => {
  const config = { date: '2026-10-03', timezone: 'Europe/Paris' };
  assert.equal(dayOf(config, 1), '2026-10-04');
  assert.equal(dayOf(config, 0), '2026-10-03');
  assert.equal(startsAt(config, { hour: 9, minute: 0 }, 1).toISOString(), '2026-10-04T07:00:00.000Z');
  // Passage à l'heure d'hiver (25/10/2026) : le jour suivant reste correct.
  assert.equal(dayOf({ date: '2026-10-24' }, 1), '2026-10-25');
});
