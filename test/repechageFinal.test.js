// Épreuves avec repêchages (Marathon Fleuret) : seul le tableau final de 8 est importé, sur FTL et engarde.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/services/engardeParser');
const { manifest } = require('../src/services/engardeSync');
const { validateManifest } = require('../src/services/roundManifest');
const { observe } = require('../src/services/ftlSync');
const { config, page, samples, eventId } = require('./fixtures/ftl-marathon/pages');
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('engarde : formule avec repêchages, seul le « Tableau final de 8 » est retenu', () => {
  const pages = E.competitionPages(fixture('engarde/repechage-fdu14-index.html'), {
    org: 'cep',
    event: 'cmf2024',
    compe: 'fdu14',
  });
  assert.equal(pages.repechage, true);
  assert.deepEqual(pages.tableaus, ['https://engarde-service.com/competition/cep/cmf2024/fdu14/tableau8.htm']);
  assert.equal(pages.pools.length, 2);
  const { matches, rounds } = E.parseTableaus([fixture('engarde/repechage-fdu14-tableau8.html')], {
    allowPartial: true,
  });
  assert.deepEqual(
    matches.map((m) => m.sourceKey),
    ['T8:1', 'T8:2', 'T8:3', 'T8:4', 'T4:1', 'T4:2', 'T2:1'],
  );
  assert.deepEqual(
    [matches[0].player1, matches[0].seed1, matches[0].player2, matches[0].seed2, matches[0].winner],
    ['YANG Audrey', 1, 'BOLORE Mélisande', 8, 1],
  );
  assert.deepEqual(
    validateManifest(manifest(rounds)).map((r) => [r.round, r.previousRound]),
    [
      ['T8', null],
      ['T4', 'T8'],
      ['T2', 'T4'],
    ],
  );
});

test('engarde : formule classique inchangée (aucune page « tableau final » exigée)', () => {
  const html = ['tireurs.htm', 'poules1.htm', 'tableau64.htm', 'tableau16.htm', 'clasfinal.htm']
    .map((f) => `<a class="link-competition" href="/competition/o/e/c/${f}">Tableau de x</a>`)
    .join('');
  const pages = E.competitionPages(html, { org: 'o', event: 'e', compe: 'c' });
  assert.equal(pages.repechage, false);
  assert.equal(pages.tableaus.length, 2);
});

test('FTL : formule avec repêchages, seul l’arbre « Final 8 » est importé', async () => {
  const sourceUrl = `https://www.fencingtimelive.com/tableaus/scores/${eventId}/DDE3514325614805A7964AA0BFF3B666`;
  const finalist = [
    'JINCHARADZE Anano',
    'COURIVAULT Julie',
    'THILLAYE Nina',
    'LASSELIN Coline',
    'AMR HOSSNY Sara',
    'DUPUY Lola',
    'MARCEL VU Elisa',
    'DIRLAOUEN Victorine',
  ];
  const c = {
    name: config.event,
    podiumFormat: 'INDIVIDUAL',
    rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${eventId}`,
    podiumRoster: finalist.map((name, i) => ({ id: String(i), name })),
  };
  const asked = [];
  const final = '8E7FFB217F534B89BC7FBA4DBF934C29';
  const obs = await observe(
    c,
    [],
    {
      get: async (u) => {
        asked.push(u);
        if (u.endsWith('/trees'))
          return [
            { treeNum: 0, name: 'Primary Tableau', guid: '1EFFBD33EC064A16B761A682FB3D098A', numTables: 3 },
            { treeNum: 1, name: 'T64 Rep 1/2 (C)', guid: 'F7876A9EAE01455C94EBCC67BA2B2B97', numTables: 1 },
            { treeNum: 3, name: 'T32 (EFG)', guid: '96CB7EFAFD2B460BBADFC324CDAF22DA', numTables: 3 },
            { treeNum: 7, name: 'Final 8', guid: final, numTables: 3 },
            { treeNum: 8, name: 'Bronze Medal', guid: 'D2660604286F4B33BFA509F756842010', numTables: 1 },
          ];
        if (u.includes(`/trees/${final}/`)) return fixture('ftl-final8.html');
        if (u === sourceUrl) return page(samples[0]);
        throw new Error(`Page hors scénario : ${u}`);
      },
    },
    { ...config, name: c.name, sourceUrl },
    true,
  );
  assert.ok(
    asked.every((u) => !u.includes('1EFFBD33EC064A16B761A682FB3D098A')),
    'tableau principal non lu',
  );
  assert.deepEqual(
    obs.matches.map((m) => [m.sourceKey, m.round, m.player1, m.player2, m.winner, m.seed1, m.seed2]),
    [
      ['Quarterfinals:1', 'T8', 'JINCHARADZE Anano', 'COURIVAULT Julie', 1, 1, 8],
      ['Quarterfinals:2', 'T8', 'THILLAYE Nina', 'LASSELIN Coline', 1, 5, 4],
      ['Quarterfinals:3', 'T8', 'AMR HOSSNY Sara', 'DUPUY Lola', 1, 3, 6],
      ['Quarterfinals:4', 'T8', 'MARCEL VU Elisa', 'DIRLAOUEN Victorine', 1, 7, 2],
      ['Semi-Finals:1', 'T4', 'JINCHARADZE Anano', 'THILLAYE Nina', 1, 1, 5],
      ['Semi-Finals:2', 'T4', 'AMR HOSSNY Sara', 'MARCEL VU Elisa', 1, 3, 7],
      ['Finals:1', 'T2', 'JINCHARADZE Anano', 'AMR HOSSNY Sara', 2, 1, 3],
    ],
  );
  assert.deepEqual(
    obs.rounds.map((r) => [r.round, r.previousRound, r.expectedMatchCount]),
    [
      ['T8', null, 4],
      ['T4', 'T8', 2],
      ['T2', 'T4', 1],
    ],
  );
});
