// Suivi des équipes : toujours dans une épreuve précise (les équipes de France ont toutes le même nom),
// à la main ou automatiquement par un tireur suivi présent dans la composition (Engarde).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/services/teamFollows');
const { namesFor } = require('../src/services/fencerNotifications');
const E = require('../src/services/engardeParser');

const roster = E.parseRoster(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'engarde', 'equipes-fdm20-liste.html'), 'utf8'),
);
const competition = { id: 7, podiumFormat: 'TEAM', podiumRoster: roster };
const teams = T.teamsOf(competition);

test('la composition Engarde est connue et sert au suivi automatique', () => {
  const antony = teams.find((t) => t.name === 'ANTONY 1');
  assert.ok(antony.members.includes('CHOUET Lise'));
  const favorite = { name: 'CHOUET Lise', club: 'ANTONY', country: 'FRA' };
  assert.equal(T.memberMatch(favorite, antony, teams), 'CHOUET Lise');
  // Même nom, autre club, et nom présent une seule fois dans l'épreuve : accepté (seul candidat possible).
  assert.equal(T.memberMatch({ name: 'CHOUET Lise', club: 'AUTRE' }, antony, teams), 'CHOUET Lise');
  assert.equal(T.memberMatch({ name: 'INCONNUE Zoé' }, antony, teams), null);
});

test('équipe suivie à la main ou par un membre suivi ; une épreuve individuelle ne renvoie rien', () => {
  const paris = teams.find((t) => t.name === 'PARIS CEP 1');
  const v = T.view(competition, [{ id: 3, entryId: String(paris.id) }], [{ name: 'AMAR Alice', club: 'ANTONY' }]);
  const row = (name) => v.teams.find((t) => t.name === name);
  assert.equal(row('PARIS CEP 1').followId, 3);
  assert.equal(row('ANTONY 1').autoMember, 'AMAR Alice');
  assert.deepEqual(v.names.sort(), ['ANTONY 1', 'PARIS CEP 1']);
  assert.deepEqual(T.teamsOf({ podiumFormat: 'INDIVIDUAL', podiumRoster: roster }), []);
});

test('les notifications d’une épreuve par équipes visent les équipes suivies de cette épreuve seulement', async () => {
  const paris = teams.find((t) => t.name === 'PARIS CEP 1');
  const db = {
    followedFencer: { findMany: async () => [] },
    followedTeam: {
      findMany: async ({ where }) => (where.competitionId === 7 ? [{ id: 1, entryId: String(paris.id) }] : []),
    },
  };
  assert.deepEqual(await namesFor(db, { userId: 4 }, competition), ['PARIS CEP 1']);
  // Même nom d'équipe dans une autre épreuve par équipes : rien n'est suivi.
  assert.deepEqual(await namesFor(db, { userId: 4 }, { ...competition, id: 8 }), []);
});

test('suivre : épreuve par équipes et équipe de la liste officielle exigées', async () => {
  const db = {
    competition: {
      findUnique: async ({ where }) => (where.id === 7 ? competition : { id: 9, podiumFormat: 'INDIVIDUAL' }),
    },
  };
  await assert.rejects(T.follow(db, 4, 9, 'x'), /pas une épreuve par équipes/);
  await assert.rejects(T.follow(db, 4, 7, 'inconnue'), /absente de la liste officielle/);
});
