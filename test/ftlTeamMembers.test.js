// FencingTimeLive : les données de l'onglet « Teams » (/events/competitors/data/<épreuve>) portent la
// composition de chaque équipe (« members ») ; elle sert au suivi automatique des équipes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRoster } = require('../src/services/ftlConfiguration');
const { withMembers } = require('../src/services/ftlRenames');
const T = require('../src/services/teamFollows');

const id = (n) => String(n).padStart(32, 'A');
const member = (n, name) => ({ id: id(n), name, paraCat: null });
// Extrait au format réel (Takamatsu, fleuret hommes par équipes, 19/10/2026).
const rows = [
  {
    id: id(1),
    status: 'CheckedIn',
    name: 'FRANCE',
    country: 'FRA',
    rank: 5,
    rankSort: 5,
    members: [
      member(11, 'BIBARD Tyvan'),
      member(12, 'SAVIN Rafael'),
      member(13, 'PAUTY Maxime'),
      member(14, 'HELMY-COCOYNACQ Adrien'),
    ],
  },
  {
    id: id(2),
    status: 'CheckedIn',
    name: 'ITALY',
    country: 'ITA',
    rank: 1,
    rankSort: 1,
    members: [member(21, 'MARINI Tommaso'), member(22, 'MACCHI Filippo')],
  },
];

test('la composition FTL est gardée dans la liste des engagés', () => {
  const roster = parseRoster(rows);
  const france = roster.find((e) => e.name === 'FRANCE');
  assert.deepEqual(france.members, ['BIBARD Tyvan', 'SAVIN Rafael', 'PAUTY Maxime', 'HELMY-COCOYNACQ Adrien']);
  // Épreuve individuelle : aucun champ ajouté.
  assert.equal('members' in parseRoster([{ id: id(3), name: 'PAUTY Maxime', country: 'FRA' }])[0], false);
});

test('suivi automatique d’une équipe FTL par un tireur suivi (même nom, même nation)', () => {
  const competition = { id: 29, podiumFormat: 'TEAM', podiumRoster: parseRoster(rows) };
  const v = T.view(competition, [], [{ name: 'PAUTY Maxime', country: 'FRA', club: '' }]);
  assert.deepEqual(v.names, ['FRANCE']);
  assert.equal(v.teams.find((t) => t.name === 'FRANCE').autoMember, 'PAUTY Maxime');
});

test('composition publiée après le paramétrage : ajoutée à la liste enregistrée, rien si inchangée', () => {
  const stored = parseRoster(rows.map(({ members, ...r }) => r));
  const observed = parseRoster(rows);
  const updated = withMembers(stored, observed);
  assert.deepEqual(updated.find((e) => e.name === 'ITALY').members, ['MARINI Tommaso', 'MACCHI Filippo']);
  assert.equal(withMembers(updated, observed), null);
});
