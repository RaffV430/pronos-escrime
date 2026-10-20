// « Mes tireurs » : un tireur suivi qui a un homonyme d'un autre club dans l'épreuve (deux « ROBERT Julien »,
// Journées de l'épée 2026) est reconnu par son nom et son club, jamais confondu avec l'autre.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../src/services/fencerFollows');
const { matchedNames, concerned, isMine, hasAny } = require('../src/services/fencerNotifications');
const { fencerResultText } = require('../src/services/notificationText');

const competition = {
  id: 28,
  name: 'Épée Hommes senior',
  podiumFormat: 'INDIVIDUAL',
  podiumRoster: [
    { id: 'd', name: 'ROBERT Julien', country: 'DECINES TE' },
    { id: 'p', name: 'ROBERT Julien', country: 'PERPIGNAN RO' },
    { id: 'b', name: 'BRES Nicolas', country: 'ST PAUL 3CHX' },
  ],
};
const perpignan = { id: 7, name: 'ROBERT Julien', club: 'PERPIGNAN RO' };
const match = (player1, club1, player2, club2, winner = 1) => ({
  id: 1,
  round: 'T256',
  player1,
  club1,
  player2,
  club2,
  winner,
  score1: winner === 1 ? 15 : 11,
  score2: winner === 2 ? 15 : 11,
  isFinished: true,
});

test('homonyme suivi : reconnu par son club, pas par le nom seul', () => {
  const r = resolve([perpignan], competition);
  assert.deepEqual(r.links, [{ entryId: 'p', favoriteId: 7 }]);
  assert.deepEqual(r.matchNames, []);
  assert.deepEqual(r.clubNames, [{ name: 'ROBERT Julien', club: 'PERPIGNAN RO' }]);
  const names = matchedNames([perpignan], competition);
  assert.ok(hasAny(names));
  assert.ok(isMine(names, 'ROBERT Julien', 'PERPIGNAN RO'));
  assert.ok(!isMine(names, 'ROBERT Julien', 'DECINES TE'));
  assert.ok(!isMine(names, 'ROBERT Julien', null), 'club inconnu : jamais attribué');
  // Ses matchs déclenchent les alertes ; ceux de l'homonyme de Décines, non.
  assert.ok(concerned(match('ROBERT Julien', 'PERPIGNAN RO', 'BRES Nicolas', 'ST PAUL 3CHX'), names));
  assert.ok(!concerned(match('ROBERT Julien', 'DECINES TE', 'HUBERT Thomas', 'DUCOS MSQ'), names));
  // Texte du résultat : son match à lui.
  const text = fencerResultText(
    competition,
    match('ROBERT Julien', 'PERPIGNAN RO', 'BRES Nicolas', 'ST PAUL 3CHX'),
    names,
  );
  assert.match(text.body, /ROBERT Julien passe/);
  const other = fencerResultText(
    competition,
    match('ROBERT Julien', 'DECINES TE', 'HUBERT Thomas', 'DUCOS MSQ'),
    names,
  );
  assert.ok(!other.body);
});

test('sans homonyme : reconnu par le nom comme avant ; même nom et même club : jamais attribué', () => {
  const bres = { id: 8, name: 'BRES Nicolas', club: 'ST PAUL 3CHX' };
  const names = matchedNames([bres], competition);
  assert.deepEqual([...names], ['BRES Nicolas']);
  assert.ok(isMine(names, 'BRES Nicolas', null));
  const twins = {
    ...competition,
    podiumRoster: [
      { id: 'a', name: 'ROBERT Julien', country: 'PERPIGNAN RO' },
      { id: 'b', name: 'ROBERT Julien', country: 'PERPIGNAN RO' },
    ],
  };
  const r = resolve([perpignan], twins);
  assert.deepEqual(r.clubNames, []);
  assert.ok(!hasAny(matchedNames([perpignan], twins)));
});
