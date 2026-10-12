const { test } = require('node:test');
const assert = require('node:assert/strict');
const { directory } = require('../src/services/fencerDirectory');
const { compatible } = require('../src/services/fencerFollows');
test('répertoire indépendant : fiche sans épreuve et profil engagé regroupé, favoris stables', () => {
  const profile = { id: 42, name: 'TEST Lea', country: 'FRA', club: 'Club', birthYear: 1965, federationVerified: true };
  const favorite = {
    id: 9,
    affiliationId: 42,
    name: profile.name,
    country: 'FRA',
    club: 'Club',
    originCompetitionId: null,
  };
  assert.equal(directory([], [favorite], {}, [profile])[0].favoriteId, 9);
  const result = directory(
    [
      {
        id: 1,
        name: 'Test',
        podiumRoster: [{ id: 'entry', affiliationId: 42, name: profile.name, country: 'FRA', club: 'Club' }],
      },
    ],
    [favorite],
    {},
    [profile],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].events.length, 1);
  assert.equal(result[0].affiliationId, 42);
  assert.equal(compatible(favorite, { id: 'unknown', name: profile.name, country: 'FRA', club: 'Club' }, 1), false);
});
