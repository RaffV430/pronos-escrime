const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/services/notificationText');
const { reminderText } = require('../src/services/poolReminders');

const c = { name: 'Fleuret Juniors Dames', tournamentId: 4, id: 16 };
const now = new Date('2026-10-12T10:00:00Z');
const at = '2026-10-12T11:27:00Z';
const m = { id: 1, round: 'T32', startsAt: at, closesAt: at, player1: 'MARTIN Léa', player2: 'DURAND Chloé' };

test('my fencers mode names the fencers and drops the Paris offset', () => {
  assert.equal(
    t.matchNotificationText(c, 'T32', [m], 'Europe/Paris', 'AVAILABLE', now, ['MARTIN Léa']).body,
    'MARTIN Léa – DURAND Chloé · T32 à pronostiquer · clôture à 13:27',
  );
  const three = [m, { ...m, id: 2, player1: 'ROUX Ana' }, { ...m, id: 3, player1: 'PETIT Zoé' }];
  assert.equal(
    t.matchNotificationText(c, 'T32', three, 'Europe/Paris', 'REMINDER', now, ['MARTIN Léa', 'ROUX Ana', 'PETIT Zoé'])
      .body,
    'T32 · MARTIN Léa et 2 autres tireurs · 3 matchs à compléter · clôture à 13:27',
  );
  assert.equal(
    t.matchNotificationText(c, 'T32', [m], 'Europe/Paris', 'AVAILABLE', now).body,
    'T32 · 1 match à pronostiquer · clôture à 13:27',
  );
});

test('results of my fencers read naturally', () => {
  const r = (x) => t.fencerResultText(c, { ...m, ...x }, ['MARTIN Léa']).body;
  assert.equal(r({ score1: 15, score2: 11, winner: 1 }), '✅ MARTIN Léa passe en T16 (15–11 contre DURAND Chloé)');
  assert.equal(
    r({ round: 'T16', score1: 15, score2: 11, winner: 1 }),
    '✅ MARTIN Léa passe en quarts de finale (15–11 contre DURAND Chloé)',
  );
  assert.equal(
    r({ round: 'T8', score1: 12, score2: 15, winner: 2 }),
    'MARTIN Léa s’arrête en quarts de finale (15–12 contre DURAND Chloé)',
  );
  assert.equal(
    r({ round: 'T2', score1: 15, score2: 14, winner: 1 }),
    '🏆 MARTIN Léa remporte l’épreuve (15–14 en finale contre DURAND Chloé)',
  );
  assert.equal(
    r({ round: 'T4', resultType: 'MEDICAL_WITHDRAWAL', winner: 1 }),
    '✅ MARTIN Léa passe en finale (abandon de DURAND Chloé)',
  );
  const pool = {
    name: 'Poule 4',
    fencers: [
      { id: 1, name: 'MARTIN Léa', wins: 5, losses: 1, indicator: 14 },
      { id: 2, name: 'X', wins: 6, losses: 0, indicator: 20 },
    ],
  };
  assert.equal(t.fencerPoolText(c, pool, pool.fencers[0]).body, 'Poule 4 · MARTIN Léa : 5 V – 1 D, indice +14, 2e/2');
});

test('pool reminder names the pool of my fencer', () => {
  const pool = {
    id: 3,
    name: 'Poule 4',
    lockMode: 'START_OR_FIRST_RESULT',
    closesAt: at,
    startsAt: at,
    fencers: [{ name: 'MARTIN Léa' }],
  };
  assert.equal(
    reminderText(c, [pool], 'Europe/Paris', ['MARTIN Léa']).body,
    'Poule 4 de MARTIN Léa · pronostic à compléter · clôture vers 13:27',
  );
});
