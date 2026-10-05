// Lieu, date et jour des phases corrigés par un administrateur.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/schedule');

test('correction validée, champs vides = retour à l’automatique', () => {
  const c = S.validateCorrection({
    city: 'Samsun',
    timezone: 'Europe/Istanbul',
    country: 'tur',
    date: '2026-09-25',
    phaseDays: { 'pools-2': '2026-09-26', T64: '2026-09-27' },
  });
  assert.deepEqual(c, {
    city: 'Samsun',
    timezone: 'Europe/Istanbul',
    country: 'TUR',
    date: '2026-09-25',
    phaseDays: { 'pools-2': '2026-09-26', T64: '2026-09-27' },
  });
  const back = S.validateCorrection({ phaseDays: { T64: '' }, city: '' }, c);
  assert.deepEqual(back.phaseDays, { 'pools-2': '2026-09-26' });
  assert.equal(back.city, undefined);
  for (const bad of [
    { timezone: 'Mars/Olympus' },
    { date: '25/09/2026' },
    { phaseDays: { T63x: '2026-09-27' } },
    { country: 'FRANCE' },
  ])
    assert.throws(() => S.validateCorrection(bad), /invalide|inconnue/);
});

test('fusion avec la configuration et jour imposé d’une phase', () => {
  const config = { date: '2026-09-24', timezone: 'Europe/Paris', city: 'Paris', name: 'X' };
  const merged = S.merge(config, { city: 'Samsun', timezone: 'Europe/Istanbul', phaseDays: { T32: '2026-09-25' } });
  assert.deepEqual(
    [merged.city, merged.timezone, merged.date, merged.name],
    ['Samsun', 'Europe/Istanbul', '2026-09-24', 'X'],
  );
  assert.equal(S.phaseDay(merged, 'T32'), '2026-09-25');
  assert.equal(S.phaseDay(merged, 'T16'), null);
  assert.equal(S.merge(null, { city: 'X' }), null, 'jamais de configuration inventée');
  assert.equal(S.daysBetween('2026-09-24', '2026-09-26'), 2);
  // Même heure locale, autre jour.
  const moved = S.onDay(new Date('2026-09-24T13:30:00Z'), '2026-09-25', 'Europe/Paris');
  assert.equal(moved.toISOString(), '2026-09-25T13:30:00.000Z');
});
