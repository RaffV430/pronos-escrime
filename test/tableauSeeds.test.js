// Têtes de série du tableau : lues sur la source officielle, affichées devant le nom des tireurs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const { parseTable } = require('../src/services/ftlParser');
const E = require('../src/services/engardeParser');
const fixture = (...p) => fs.readFileSync(path.join(__dirname, 'fixtures', ...p), 'utf8');

test('FencingTimeLive : tête de série « (n) » de chaque adversaire', () => {
  const html = fixture('ftl-individual-partial.html');
  const $ = load(html);
  const roster = [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
  const r = parseTable(html, { date: '2026-09-27', roster, maxScore: 15, requireComplete: false });
  assert.ok(r.matches.every((m) => Number.isInteger(m.seed1) && Number.isInteger(m.seed2)));
  // Une tireuse garde la même tête de série à tous les tours.
  const byName = new Map();
  for (const m of r.matches)
    for (const [n, s] of [
      [m.player1, m.seed1],
      [m.player2, m.seed2],
    ]) {
      if (byName.has(n)) assert.equal(byName.get(n), s, n);
      byName.set(n, s);
    }
  const wang = r.matches.find((m) => m.player1 === 'WANG Yiran' || m.player2 === 'WANG Yiran');
  assert.equal(wang.player1 === 'WANG Yiran' ? wang.seed1 : wang.seed2, 1);
});

test('engarde-service : numéro d’entrée du plus grand tableau publié', () => {
  const { matches } = E.parseTableaus([
    fixture('engarde', 'fdm20-tableau64-top.html'),
    fixture('engarde', 'fdm20-tableau16.html'),
  ]);
  const seedOf = (name) => {
    const m = matches.find((x) => x.player1 === name || x.player2 === name);
    return m.player1 === name ? m.seed1 : m.seed2;
  };
  assert.equal(seedOf('BOLORE Mélisande'), 1);
  // Page du tableau de 16 : GIMARD y figure en position 16, mais sa tête de série (tableau de 64) est 17.
  assert.equal(seedOf('GIMARD Ninon'), 17);
  assert.equal(seedOf('PIERRAIN Lauryne'), 32);
  // Tableau de 16 seul : ses numéros sont les têtes de série.
  const only16 = E.parseTableaus([fixture('engarde', 'fdm20-tableau16.html')]).matches;
  assert.deepEqual([only16[0].seed1, only16[0].seed2], [1, 16]);
});

test('FTL : la petite finale conserve les têtes de série du tableau principal', () => {
  const html = fixture('ftl-team.html');
  const $ = load(html);
  const roster = [
    ...new Set(
      $('.tcln')
        .toArray()
        .map((e) => cleanName($(e).text()))
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
  const entrySeeds = new Map();
  parseTable(html, { date: '2026-09-27', roster, entrySeeds });
  const [bronze] = parseTable(fixture('ftl-team-bronze.html'), {
    date: '2026-09-27',
    roster,
    entrySeeds,
    bronze: true,
  }).matches;
  assert.deepEqual(
    [bronze.player1, bronze.seed1, bronze.player2, bronze.seed2],
    ['RUSSIA', 7, 'UNITED STATES OF AMERICA', 2],
  );
  assert.deepEqual([bronze.score1, bronze.score2, bronze.winner], [45, 42, 1]);
  const alone = parseTable(fixture('ftl-team-bronze.html'), { date: '2026-09-27', roster, bronze: true }).matches[0];
  assert.deepEqual([alone.seed1, alone.seed2], [null, null], 'pas de fausse tête de série 1/2 sans tableau principal');
});

const cleanName = (name) => name.replace(/\s+/g, ' ').trim();

test('engarde équipes : nations normalisées et bronze gardent leur classement d’entrée', () => {
  const { matches, rounds } = E.parseTableaus([fixture('engarde', 'equipes-fdm20-tableau16.html')]);
  const bronze = matches.find((m) => m.round === 'Bronze');
  assert.deepEqual([bronze.seed1, bronze.seed2], [5, 11]);
  assert.equal(rounds.find((r) => r.round === 'Bronze').previousRound, 'T4');
  const international = E.parseTableaus([fixture('engarde', 'equipes-fheq-tableau16.html')]).matches;
  const first = international.find((m) => m.sourceKey === 'T16:1');
  assert.deepEqual([first.player1, first.seed1, first.player2, first.seed2], ['ITALY', 1, 'SPAIN', 16]);
});
