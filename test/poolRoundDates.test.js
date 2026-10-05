// Tours de poules FencingTimeLive après le premier : date déduite (heure seule publiée) et annonce aux joueurs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { phaseDate } = require('../src/services/ftlSync');
const alerts = require('../src/services/poolRoundAlerts');

const tz = 'Europe/Paris';
const paris = (s) => new Date(`${s}+02:00`);
const base = { round: 2, date: '2026-10-10', timezone: tz, previousStarts: [paris('2026-10-10T09:00:00')] };

test('tour 2 plus tard le même jour : même date', () => {
  const now = paris('2026-10-10T12:30:00').getTime();
  assert.equal(
    phaseDate({
      ...base,
      times: [
        { hour: 13, minute: 0 },
        { hour: 13, minute: 30 },
      ],
      now,
    }),
    '2026-10-10',
  );
});

test('tour suivant plus tôt que le précédent : lendemain', () => {
  const now = paris('2026-10-10T18:00:00').getTime();
  assert.equal(
    phaseDate({ ...base, previousStarts: [paris('2026-10-10T14:00:00')], times: [{ hour: 8, minute: 0 }], now }),
    '2026-10-11',
  );
});

test('tour publié la veille au soir pour le lendemain matin : lendemain', () => {
  const now = paris('2026-10-10T19:00:00').getTime();
  assert.equal(phaseDate({ ...base, times: [{ hour: 10, minute: 0 }], now }), '2026-10-11');
});

test('tour vu peu après son début : même date (le premier résultat ferme de toute façon)', () => {
  const now = paris('2026-10-10T14:00:00').getTime();
  assert.equal(phaseDate({ ...base, times: [{ hour: 13, minute: 0 }], now }), '2026-10-10');
});

test('date déjà retenue conservée ; sans repère : pas de clôture horaire', () => {
  const now = paris('2026-10-11T20:00:00').getTime();
  assert.equal(
    phaseDate({ ...base, currentStarts: [paris('2026-10-10T13:00:00')], times: [{ hour: 13, minute: 0 }], now }),
    '2026-10-10',
  );
  assert.equal(phaseDate({ ...base, previousStarts: [], times: [{ hour: 13, minute: 0 }], now }), null);
  assert.equal(phaseDate({ ...base, times: [], now }), null);
  assert.equal(phaseDate({ ...base, round: 1, times: [] }), '2026-10-10');
});

test('annonce d’un nouveau tour : une fois par tour et par appareil, texte avec l’heure de clôture', async () => {
  const created = [];
  const db = {
    pool: {
      findMany: async () => [
        { id: 1, name: 'Poule 1' },
        { id: 7, name: 'Tour 2 · Poule 1' },
        { id: 8, name: 'Tour 2 · Poule 2' },
      ],
    },
    pushSubscription: { findMany: async () => [{ id: 'a' }, { id: 'b' }] },
    pushDelivery: {
      createMany: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true);
        created.push(...data);
        return { count: data.length };
      },
    },
  };
  assert.equal(await alerts.alertNewPoolRounds(db, { id: 3, tournamentId: 1 }), 2);
  assert.deepEqual(
    created.map((d) => [d.subscriptionId, d.kind, d.round, d.matchIds]),
    [
      ['a', 'POOLS', 'pools-new-2', [7, 8]],
      ['b', 'POOLS', 'pools-new-2', [7, 8]],
    ],
  );
  assert.equal(alerts.roundOfDelivery('pools-new-2'), 2);
  assert.equal(alerts.roundOfDelivery('pools-12'), null);
  const now = paris('2026-10-10T12:30:00').getTime();
  const n = alerts.newRoundNotification(
    { id: 3, tournamentId: 1, name: 'Fleuret Hommes' },
    2,
    [{ lockMode: 'START_OR_FIRST_RESULT', closesAt: paris('2026-10-10T13:00:00') }],
    now,
  );
  assert.equal(n.title, 'Tour 2 de poules · Fleuret Hommes');
  assert.match(n.body, /ouverts jusqu'à 13:00/);
  assert.match(
    alerts.newRoundNotification({ id: 3, tournamentId: 1, name: 'X' }, 3, [{ lockMode: 'FIRST_RESULT' }], now).body,
    /jusqu'au premier résultat/,
  );
});
