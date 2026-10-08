const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identity, keyFor, resolve } = require('../src/services/fencerFollows');
const f = { id: 1, name: 'MARTIN Léa', country: 'FRA', club: '', originCompetitionId: 1, originEntryId: 'cadet' };
const event = (entries, id = 2) => ({ id, podiumFormat: 'INDIVIDUAL', podiumRoster: entries });
test('cadet, junior et tournoi suivant : identité indépendante de l’identifiant officiel et des accents', () => {
  for (const id of [2, 3])
    assert.deepEqual(resolve([f], event([{ id: 'junior', name: 'martin Lea', country: 'FRA' }], id)).links, [
      { entryId: 'junior', favoriteId: 1 },
    ]);
  assert.equal(keyFor(f), keyFor({ ...f, name: 'martin Lea', originCompetitionId: 9, originEntryId: 'other' }));
});
test('nation canonique et club national ne sont pas confondus', () => {
  assert.deepEqual(identity({ name: 'A', country: 'GER' }), { name: 'A', country: 'DEU', club: '' });
  assert.deepEqual(identity({ name: 'A', country: 'PARIS CEP' }), { name: 'A', country: '', club: 'PARIS CEP' });
});
test('homonymes, nations/club incompatibles et métadonnées manquantes : aucun suivi automatique', () => {
  for (const entries of [
    [{ id: 'x', name: f.name, country: 'ITA' }],
    [{ id: 'x', name: f.name, country: '' }],
    [
      { id: 'x', name: f.name, country: 'FRA' },
      { id: 'y', name: f.name, country: 'FRA' },
    ],
    [{ id: 'x', name: f.name, country: 'FRA', club: 'CEP' }],
  ])
    assert.deepEqual(resolve([f], event(entries)).links, []);
  assert.deepEqual(
    resolve([{ ...f, club: 'CEP' }], event([{ id: 'x', name: f.name, country: 'FRA', club: 'MELUN' }])).links,
    [],
  );
});
test('origine précise reconnue mais jamais de marquage par nom en présence d’un homonyme', () => {
  const result = resolve(
    [f],
    event(
      [
        { id: 'cadet', name: f.name, country: 'FRA' },
        { id: 'other', name: f.name, country: 'FRA' },
      ],
      1,
    ),
  );
  assert.equal(result.links.length, 1);
  assert.deepEqual(result.matchNames, []);
  assert.deepEqual(
    resolve([f], { id: 2, podiumFormat: 'TEAM', podiumRoster: [{ id: 'x', name: f.name, country: 'FRA' }] }).links,
    [],
  );
});
