const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fencerProfile } = require('../src/services/fencerProfile');
const { headToHead } = require('../src/services/headToHead');
test('homonyms with different nations are not merged into one fencer profile', async () => {
  const db = {
    match: {
      findMany: async ({ where }) => {
        assert.equal(where.pointsPending, false);
        return [];
      },
    },
    poolFencer: { findMany: async () => [] },
    competition: {
      findMany: async () =>
        ['FRA', 'ITA'].map((country, id) => ({ id, podiumRoster: [{ name: 'MARTIN Alex', country }] })),
    },
  };
  await assert.rejects(
    fencerProfile(db, 'MARTIN Alex'),
    (e) => e.status === 409 && /Historique non fusionné/.test(e.message),
  );
});
test('head-to-head excludes pending results and histories of another nationality', async () => {
  const roster = (country) => [
    { name: 'MARTIN Alex', country },
    { name: 'ROSSI Ana', country: 'ITA' },
  ];
  const match = (country) => ({
    id: 1,
    player1: 'MARTIN Alex',
    player2: 'ROSSI Ana',
    score1: 15,
    score2: 9,
    winner: 1,
    competition: { podiumRoster: roster(country) },
  });
  const db = {
    match: {
      findUnique: async () => ({ ...match('FRA'), id: 99 }),
      findMany: async ({ where }) => {
        assert.ok(where.AND.some((x) => x.pointsPending === false));
        return [match('ITA'), match('FRA')];
      },
    },
    pool: { findMany: async () => [] },
  };
  const result = await headToHead(db, 99);
  assert.equal(result.meetings.length, 1);
  assert.equal(result.form.player1.length, 1);
});

test('homonyms inside the same roster never produce a combined head-to-head', async () => {
  const db = {
    match: {
      findUnique: async () => ({
        id: 1,
        player1: 'MARTIN Alex',
        player2: 'ROSSI Ana',
        competition: {
          podiumRoster: [
            { name: 'MARTIN Alex', country: 'FRA' },
            { name: 'MARTIN Alex', country: 'ITA' },
          ],
        },
      }),
    },
  };
  await assert.rejects(headToHead(db, 1), (e) => e.status === 409);
});

test('un sigle de club à 3 lettres (liste nationale) n’est pas une nationalité', async () => {
  const { countryFor } = require('../src/services/matchCountries');
  assert.equal(countryFor([{ name: 'MARTIN Alex', country: 'CEP' }], 'MARTIN Alex'), null);
  assert.equal(countryFor([{ name: 'MARTIN Alex', country: 'FRA' }], 'MARTIN Alex'), 'FRA');
  assert.equal(countryFor([{ name: 'MARTIN Alex', country: 'GER' }], 'MARTIN Alex'), 'DEU');
  assert.equal(countryFor([{ name: 'MARTIN Alex', country: 'AIN' }], 'MARTIN Alex'), null);
  // Même tireur : club en épreuve nationale, FRA en épreuve internationale → une seule nationalité.
  const db = {
    match: { findMany: async () => [] },
    poolFencer: { findMany: async () => [] },
    competition: {
      findMany: async () =>
        ['CEP', 'FRA'].map((country, id) => ({
          id,
          name: 'x',
          createdAt: new Date(),
          podiumRoster: [{ name: 'MARTIN Alex', country }],
        })),
    },
  };
  const profile = await fencerProfile(db, 'MARTIN Alex');
  assert.equal(profile.name, 'MARTIN Alex');
});
