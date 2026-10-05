// Onglet « Résultats » : tournois passés, date, saison, pays du lieu et podium officiel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildResults, countryOf } = require('../src/services/eventResults');

const roster = [
  { id: 'a', name: 'DUPONT Anna', country: 'FRA' },
  { id: 'b', name: 'ROSSI Bea', country: 'ITA' },
  { id: 'c', name: 'KOVACS Cili', country: 'HUN' },
  { id: 'd', name: 'MEIER Dora', country: 'GER' },
];
const podium = { gold: 'a', silver: 'b', bronze1: 'c', bronze2: 'd', finalConfirmed: true };

test('pays : code engarde (CIO) prioritaire, sinon fuseau horaire', () => {
  assert.equal(countryOf({ country: 'ITA', timezone: 'Europe/Paris' }), 'IT');
  assert.equal(countryOf({ timezone: 'Europe/Budapest' }), 'HU');
  assert.equal(countryOf({ timezone: 'Indian/Reunion' }), 'FR');
  assert.equal(countryOf({}), null);
});

test('seules les épreuves terminées ; dates, saison, podium et tri du plus récent au plus ancien', () => {
  const tournaments = [
    {
      id: 1,
      name: 'Challenge Antony',
      createdAt: new Date('2026-09-01'),
      competitions: [
        { id: 10, name: 'Fleuret Dames', podiumFormat: 'INDIVIDUAL', podiumRoster: roster, officialPodium: podium },
        { id: 11, name: 'Fleuret Hommes', podiumFormat: 'INDIVIDUAL', podiumRoster: roster, officialPodium: null },
      ],
    },
    {
      id: 2,
      name: 'Marathon',
      createdAt: new Date('2026-01-01'),
      competitions: [
        {
          id: 20,
          name: 'Cadettes',
          podiumRoster: roster,
          officialPodium: null,
          podiumResolvedAt: new Date('2026-02-01'),
          resultsSourceUrl: 'https://x',
        },
      ],
    },
    { id: 3, name: 'À venir', createdAt: new Date(), competitions: [{ id: 30, name: 'X', officialPodium: null }] },
  ];
  const configs = new Map([[10, { date: '2026-10-04', city: 'Antony', timezone: 'Europe/Paris' }]]);
  const firstDates = new Map([[20, new Date('2026-01-31T08:00:00Z')]]);
  const out = buildResults(tournaments, { configs, firstDates });
  assert.deepEqual(
    out.map((t) => [t.name, t.start, t.season, t.city, t.countries, t.competitions.map((c) => c.name)]),
    [
      ['Challenge Antony', '2026-10-04', 2026, 'Antony', ['FR'], ['Fleuret Dames']],
      ['Marathon', '2026-01-31', 2025, null, [], ['Cadettes']],
    ],
  );
  assert.deepEqual(
    out[0].competitions[0].podium.map((p) => [p.place, p.name]),
    [
      [1, 'DUPONT Anna'],
      [2, 'ROSSI Bea'],
      [3, 'KOVACS Cili'],
      [3, 'MEIER Dora'],
    ],
  );
  assert.deepEqual(out[1].competitions[0].podium, []);
  assert.equal(out[1].competitions[0].sourceUrl, 'https://x');
});
