// Épreuves par équipes engarde-service (demi-finale des championnats de France M20 dames, Aix, 15/03/2026) :
// liste « equipes.htm », tableau principal et match pour la 3e place dans la même grille que les tableaux
// de classement, scores « 45/20 >> », classement final sans prénom.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/services/engardeParser');
const { manifest } = require('../src/services/engardeSync');
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'engarde', n), 'utf8');

test('liste des équipes : nom de l’équipe, club, tireuses, appel fait', () => {
  const html = fixture('equipes-fdm20-liste.html');
  const [antony, , aquitaine] = E.parseRoster(html);
  assert.deepEqual(
    [antony.name, antony.country, antony.entryRanking, antony.members.length],
    ['ANTONY 1', 'ANTONY', 1, 4],
  );
  assert.equal(aquitaine.country, 'LIMOGES CE');
  assert.equal(E.rosterCheckedIn(html), true);
  const pages = E.competitionPages(
    '<a class="link-competition" href="/competition/epa/aixnational/fdm20equipe/equipes.htm">x</a>',
    { org: 'epa', event: 'aixnational', compe: 'fdm20equipe' },
  );
  assert.match(pages.roster, /equipes\.htm$/);
});

test('tableau par équipes : tableau principal et 3e place, tableaux de classement ignorés', () => {
  const { matches, rounds } = E.parseTableaus([fixture('equipes-fdm20-tableau16.html')]);
  assert.deepEqual(
    rounds.map((r) => [r.round, r.expectedMatchCount, r.previousRound]),
    [
      ['T16', 8, null],
      ['T8', 4, 'T16'],
      ['T4', 2, 'T8'],
      ['T2', 1, 'T4'],
      ['Bronze', 1, 'T4'],
    ],
  );
  assert.equal(matches.length, 16);
  const final = matches.find((m) => m.round === 'T2');
  assert.deepEqual(
    [final.player1, final.player2, final.score1, final.score2, final.winner],
    ['ANTONY 1', 'PARIS CEP 2', 45, 20, 1],
  );
  const bronze = matches.find((m) => m.round === 'Bronze');
  assert.deepEqual(
    [bronze.player1, bronze.player2, bronze.score1, bronze.score2, bronze.winner],
    ['CABRIES OC 1', 'LYON MDF 1', 44, 45, 2],
  );
  assert.equal(bronze.time.hour, 14);
  assert.equal(matches.find((m) => m.sourceKey === 'T8:4').winner, 1, 'PARIS CEP 2 bat PARIS CEP 1 (45/42)');
  assert.ok(!matches.some((m) => /place/.test(m.round)));
  assert.deepEqual(
    manifest(rounds).map((r) => r.round),
    ['T16', 'T8', 'T4', 'T2', 'Bronze'],
  );
  // Page des seuls tableaux de classement (tableau4.htm) : rien à importer, sans erreur.
  const placement = fixture('equipes-fdm20-tableau16.html').replace(
    /Tableau de 16|Tableau de 8|Demi-finales|Finale|Troisième place/g,
    'Tableau 5-8 de 4',
  );
  assert.deepEqual(E.parseTableaus([placement]).matches, []);
});

test('classement final par équipes : nom de l’équipe seul', () => {
  const rows = E.parseFinalRanking(fixture('equipes-fdm20-clasfinal.html'));
  assert.deepEqual(
    rows.slice(0, 4).map((r) => [r.place, r.name, r.club]),
    [
      ['1', 'ANTONY 1', 'ANTONY'],
      ['2', 'PARIS CEP 2', 'PARIS CEP'],
      ['3', 'LYON MDF 1', 'LYON MDF'],
      ['4', 'CABRIES OC 1', 'CABRIES OC'],
    ],
  );
});

test('forfait d’une équipe au tableau (« DNS ») : qualifiée sans score', () => {
  const dns = fixture('equipes-fdm20-tableau16.html').replace('<a href="#a16-1">45/20 &gt;&gt; </a>', 'DNS');
  const m = E.parseTableaus([dns]).matches.find((x) => x.sourceKey === 'T16:1');
  assert.deepEqual([m.winner, m.isFinished, m.resultType], [1, true, 'MEDICAL_WITHDRAWAL']);
});

test('épreuve internationale par équipes : nation accolée au nom dans la colonne d’entrée', () => {
  const { matches } = E.parseTableaus([fixture('equipes-fheq-tableau16.html')]);
  const pick = (k) => matches.find((m) => m.sourceKey === k || m.round === k);
  const t = (m) => [m.player1, m.player2, m.score1, m.score2, m.winner];
  assert.deepEqual(t(pick('T16:1')), ['ITALY', 'SPAIN', 45, 15, 1]);
  const final = pick('T2');
  assert.deepEqual(
    [final.winner === 1 ? final.player1 : final.player2, [final.score1, final.score2].sort().join('-')],
    ['ITALY', '44-45'],
  );
  const bronze = pick('Bronze');
  assert.deepEqual(
    [bronze.winner === 1 ? bronze.player1 : bronze.player2, [bronze.score1, bronze.score2].sort().join('-')],
    ['USA', '33-45'],
  );
  assert.ok(matches.every((m) => !/ [A-Z]{3}$/.test(m.player1 || '') || m.player1 === 'USA'));
});

test('tour en cours sans cases vides publiées : tour ignoré et signalé, les autres tours restent lus', () => {
  const S = require('./integration/engardeScenario');
  const html = S.tableauHtml(S.mennecyEntries().slice(0, 16), [[{ w: 1, score: '15/10' }]]).replace(
    /<td class="HBD fencer">  <\/td>/g,
    '<td></td>',
  );
  assert.throws(() => E.parseTableaus([html]), /incomplet/);
  const r = E.parseTableaus([html], { allowPartial: true });
  assert.equal(r.matches.filter((m) => m.round === 'T16').length, 8);
  assert.match(r.issues[0].message, /T8 incomplet/);
});
