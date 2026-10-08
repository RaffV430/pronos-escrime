const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchedNames, concerned, queueEnrollments } = require('../src/services/fencerNotifications');
const { preferences } = require('../src/services/playerExperience');
const c = {
  id: 4,
  podiumRoster: [
    { id: 'a', name: 'MARTIN Alice', country: 'FRA', club: 'Paris' },
    { id: 'b', name: 'DURAND Zoe', country: 'FRA', club: 'Lyon' },
  ],
};
const favorite = {
  id: 1,
  name: 'MARTIN Alice',
  country: 'FRA',
  club: 'Paris',
  originCompetitionId: 4,
  originEntryId: 'a',
};
test('Mes tireurs : identité confirmée, aucun homonyme ambigu ni autre rencontre', () => {
  assert.deepEqual(matchedNames([favorite], c), ['MARTIN Alice']);
  assert.equal(concerned({ player1: 'DURAND Zoe', player2: 'MARTIN Alice' }, matchedNames([favorite], c)), true);
  assert.equal(concerned({ player1: 'DURAND Zoe', player2: 'AUTRE' }, matchedNames([favorite], c)), false);
  const ambiguous = { ...c, id: 5, podiumRoster: [...c.podiumRoster, { ...c.podiumRoster[0], id: 'c' }] };
  assert.deepEqual(matchedNames([favorite], ambiguous), []);
});
test('nouvelles préférences désactivées par défaut et strictement booléennes', () => {
  assert.equal(preferences({}).fencersOnly, false);
  assert.equal(preferences({}).fencerEntries, false);
  assert.throws(() => preferences({ fencersOnly: 'true' }));
  assert.throws(() => preferences({ fencerEntries: 1 }));
});
test('pas de recherche d’engagement sans consentement', async () => {
  await queueEnrollments({}, { preferences: {} }, []);
});
