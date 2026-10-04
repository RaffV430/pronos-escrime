// Liste des engagés engarde : renommages (identifiant conservé), nation, absents, homonymes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeRoster, entryFor } = require('../src/services/engardeRoster');
const E = require('../src/services/engardeParser');

const e = (id, name, country = '', extra = {}) => ({ id, name, country, active: true, entryRanking: null, ...extra });

test('nom corrigé : identifiant conservé, nouveau nom', () => {
  const current = [e('a', 'PINEIRA Enzo', 'FRA'), e('b', 'ROSSI Nicolo', 'ITA'), e('c', 'SIDO Alexandre', 'FRA')];
  const observed = [
    e('x', 'MOUREY PINEIRA Enzo', 'FRA'),
    e('y', "ROSSI Nicolo'", 'ITA'),
    e('c', 'SIDO Alexandre', 'FRA'),
  ];
  const { merged, renames } = mergeRoster(current, observed);
  assert.deepEqual(
    renames.map((r) => [r.id, r.to]),
    [
      ['a', 'MOUREY PINEIRA Enzo'],
      ['b', "ROSSI Nicolo'"],
    ],
  );
  assert.deepEqual(merged.map((x) => x.id).sort(), ['a', 'b', 'c']);
  assert.ok(merged.every((x) => x.active));
});

test('pas de renommage douteux : autre nation, un seul mot commun, ou deux candidats', () => {
  assert.equal(mergeRoster([e('a', 'MARTIN Paul', 'FRA')], [e('x', 'MARTIN Paul Louis', 'BEL')]).renames.length, 0);
  assert.equal(mergeRoster([e('a', 'MARTIN Paul', 'FRA')], [e('x', 'MARTIN Pierre', 'FRA')]).renames.length, 0);
  const two = mergeRoster(
    [e('a', 'MARTIN Paul', 'FRA')],
    [e('x', 'MARTIN Paul Louis', 'FRA'), e('y', 'MARTIN Paul Henri', 'FRA')],
  );
  assert.equal(two.renames.length, 0);
  assert.equal(two.merged.find((x) => x.id === 'a').active, false, 'absent de la liste : inactif');
});

test('nation et rang mis à jour, absents inactifs, nouveaux ajoutés', () => {
  const { merged } = mergeRoster(
    [e('a', 'ASK Henri', ''), e('b', 'GREGOIRE Gabriel', '')],
    [e('a', 'ASK Henri', 'SWE', { entryRanking: 12 }), e('n', 'BARON Alexis', 'FRA')],
  );
  assert.deepEqual(
    merged.find((x) => x.id === 'a'),
    e('a', 'ASK Henri', 'SWE', { entryRanking: 12 }),
  );
  assert.equal(merged.find((x) => x.id === 'b').active, false);
  assert.ok(merged.find((x) => x.id === 'n'));
});

test('homonymes départagés par la nation ou le club', () => {
  const roster = [e('a', 'MARTIN Paul', 'FRA'), e('b', 'MARTIN Paul', 'BEL'), e('c', 'SIDO Alexandre', 'FRA')];
  assert.equal(entryFor(roster, 'MARTIN Paul', 'BEL').id, 'b');
  assert.equal(entryFor(roster, 'MARTIN Paul'), null);
  assert.equal(entryFor(roster, 'Sido alexandre').id, 'c');
});

test('liste internationale : la nation devient le pays, l’identifiant ne change pas', () => {
  const html = `<table class="liste"><tr><th>R.i.</th><th>Série</th><th>Nom</th><th>Prénom</th><th>Nation</th></tr>
  <tr><td>1</td><td>31</td><td>PAUTY</td><td>Maxime</td><td><div class="country-container"><span>FRA</span></div></td></tr></table>`;
  const [p] = E.parseRoster(html);
  assert.equal(p.country, 'FRA');
  assert.equal(p.id, E.entryId('PAUTY Maxime', ''));
  assert.equal(p.entryRanking, 1);
});
