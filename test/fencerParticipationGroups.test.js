const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groups } = require('../src/services/fencerParticipationGroups');
const { directory } = require('../src/services/fencerDirectory');
const { compatible, resolve } = require('../src/services/fencerFollows');
const p = (id, event, extra = {}) => ({
  id,
  name: 'EXEMPLE Alex',
  nameKey: 'EXEMPLE ALEX',
  country: 'RUS',
  club: '',
  entries: [{ competitionId: event, entryId: 'entry-' + id }],
  ...extra,
});
test('provisional cadet/junior entries share a stable group without mutating source profiles', () => {
  const profiles = [p(3, 43), p(1, 41), p(2, 42)];
  const before = JSON.stringify(profiles);
  assert.deepEqual([...groups(profiles).values()], [1, 1, 1]);
  assert.deepEqual([...groups([...profiles].reverse()).values()], [1, 1, 1]);
  assert.equal(JSON.stringify(profiles), before);
});
test('nationalities, clubs, birth years, verified identities, simultaneous entries and missing countries stay separate', () => {
  const cases = [
    [p(1, 1), p(2, 2, { country: 'ITA' })],
    [p(1, 1, { club: 'CLUB A' }), p(2, 2, { club: 'CLUB B' })],
    [p(1, 1, { club: 'CLUB A' }), p(2, 2)],
    [p(1, 1, { birthYear: 2008 }), p(2, 2, { birthYear: 2009 })],
    [p(1, 1, { federationVerified: true }), p(2, 2, { federationVerified: true })],
    [p(1, 1), p(2, 1)],
    [p(1, 1, { country: '' }), p(2, 2, { country: '' })],
  ];
  for (const rows of cases) assert.deepEqual([...groups(rows).values()], [1, 2]);
});
test('one verified identity may anchor compatible provisional inscriptions', () => {
  const result = groups([p(1, 1), p(9, 2, { federationVerified: true })]);
  assert.deepEqual([...result.values()], [9, 9]);
});
test('directory exposes one action with all participations and recognizes an old favorite', () => {
  const profiles = [p(1, 41), p(2, 43)];
  const competitions = profiles.map((profile) => ({
    id: profile.entries[0].competitionId,
    name: 'Épreuve fictive',
    podiumRoster: [
      {
        id: profile.entries[0].entryId,
        name: profile.name,
        country: profile.country,
        affiliationId: profile.id,
        participationGroupId: 1,
      },
    ],
  }));
  const favorite = {
    id: 77,
    name: profiles[0].name,
    country: 'RUS',
    club: '',
    affiliationId: 2,
    participationGroupId: 1,
    originCompetitionId: null,
  };
  const rows = directory(competitions, [favorite], {}, profiles);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].affiliationId, 1);
  assert.equal(rows[0].favoriteId, 77);
  assert.deepEqual(
    rows[0].events.map((e) => e.id),
    [41, 43],
  );
  assert.equal(resolve([favorite], competitions[0]).links[0].favoriteId, 77);
});
test('a mismatched group or nation does not transfer a profile-only favorite', () => {
  const favorite = {
    name: 'EXEMPLE Alex',
    country: 'RUS',
    affiliationId: 1,
    participationGroupId: 1,
    originCompetitionId: null,
  };
  assert.equal(
    compatible(favorite, { name: favorite.name, country: 'RUS', affiliationId: 2, participationGroupId: 2 }, 41),
    false,
  );
  assert.equal(
    compatible(favorite, { name: favorite.name, country: 'ITA', affiliationId: 2, participationGroupId: 1 }, 41),
    false,
  );
});

test('a provisional profile cannot bypass a verified homonym of another club', () => {
  const rows = [
    p(1, 1, { club: 'CLUB A', federationVerified: true }),
    p(2, 2, { club: 'CLUB A' }),
    p(3, 3, { federationVerified: true }),
  ];
  assert.deepEqual([...groups(rows).values()], [1, 2, 3]);
});
