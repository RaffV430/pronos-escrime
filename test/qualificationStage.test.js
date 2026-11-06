// Journée qualificative engarde publiée à part (Pont-à-Mousson) : nom distinct, pas de podium.
const test = require('node:test');
const assert = require('node:assert/strict');
const stage = require('../src/services/qualificationStage');
const podiumAvailability = require('../src/services/podiumAvailability');

const QUALIF = 'ENGARDE:cerclescrimepam/ehs_2026/qualif';
const MAIN = 'ENGARDE:cerclescrimepam/ehs_2026/epreuve';

test('seule la journée déclarée dans le calendrier est qualificative', () => {
  assert.equal(stage.isQualification({ ftlEventId: QUALIF }), true);
  assert.equal(stage.isQualification({ ftlEventId: MAIN }), false);
  assert.equal(stage.isQualification({ ftlEventId: null }), false);
  assert.equal(stage.isQualification(null), false);
});

test('la qualification porte un nom distinct de l’épreuve du lendemain', () => {
  assert.equal(stage.stageName('Épée Hommes senior', QUALIF), 'Épée Hommes senior — qualification');
  assert.equal(stage.stageName('Épée Hommes senior', MAIN), 'Épée Hommes senior');
});

test('pas de podium à pronostiquer sur la qualification', async () => {
  const db = { auditLog: { findFirst: async () => null }, match: { findMany: async () => [] } };
  const result = await podiumAvailability.forCompetition(db, { id: 25, ftlEventId: QUALIF });
  assert.equal(result.notYetOpen, true);
  assert.equal(result.noPodium, true);
  assert.match(result.reason, /pas de podium/);
});
