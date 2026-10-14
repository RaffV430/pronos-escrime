const { test } = require('node:test');
const assert = require('node:assert/strict');
const { availability } = require('../src/services/podiumAvailability');
const cfg = { timezone: 'Asia/Tokyo', scheduleSessions: [{ date: '2026-10-15' }, { date: '2026-10-17' }] };
const matches = [
  { round: 'T4', player1: 'A', player2: 'B' },
  { round: 'T4', player1: 'C', player2: 'D' },
  { round: 'J1:T4', player1: 'X', player2: 'Y' },
];
const competition = { podiumRoster: ['A', 'B', 'C', 'D'].map((name) => ({ name })) };
test('tableau principal complet à la fin du J1 : ouverture sans attendre la date du J2', () => {
  assert.equal(availability(competition, cfg, matches).notYetOpen, false);
});
test('attendre les exempts, les adversaires et le tableau principal complet', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  for (const m of [
    [],
    matches.filter((m) => m.round.startsWith('J1:')),
    matches.slice(0, 1),
    [{ ...matches[0], player2: '' }, matches[1]],
  ])
    assert.equal(availability(competition, cfg, m, now).notYetOpen, true);
  assert.equal(
    availability({ ...competition, podiumRoster: competition.podiumRoster.slice(0, 3) }, cfg, matches, now).notYetOpen,
    true,
  );
});
test('une journée : inchangé ; aucun pronostic, point ou résultat modifié', () => {
  const original = structuredClone({ competition, matches });
  assert.deepEqual(availability(competition, { scheduleSessions: [{ date: '2026-10-15' }] }, matches), {
    notYetOpen: false,
  });
  availability(competition, cfg, matches, new Date('2026-10-15T00:00:00Z'));
  assert.deepEqual({ competition, matches }, original);
});

test('tableau principal avec exempts : les byes complets comptent, les byes J1 sont exclus', () => {
  const m = [{ round: 'T4', player1: 'A', player2: 'B' }];
  assert.equal(
    availability({ ...competition, tableauByes: [{ round: 'T4', name: 'C', pos: 3 }] }, cfg, m).notYetOpen,
    false,
  );
  assert.equal(
    availability({ ...competition, tableauByes: [{ round: 'J1:T4', name: 'C', pos: 3 }] }, cfg, m).notYetOpen,
    true,
  );
});
