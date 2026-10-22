const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTable } = require('../src/services/ftlParser');
const cell = (name, seed, country = '') =>
  `<td class="tbb">${seed ? `<span class="tseed">(${seed})</span>` : ''}<span class="tcln">${name}</span><span class="tcaff">${country}</span></td>`;
const html = (seed = 1, country = 'FRA') =>
  `<table class="elimTableau"><tr><th>Table of 4</th><th>Finals</th></tr><tr>${cell('Synthetic A', seed, country)}<td></td></tr><tr><td></td>${cell('Synthetic A')}</tr><tr>${cell('- BYE -', 4)}<td></td></tr><tr><td></td><td><span class="tsco"></span></td></tr><tr>${cell('Synthetic B', 2)}<td></td></tr><tr><td></td>${cell('Synthetic B')}</tr><tr>${cell('- BYE -', 3)}<td></td></tr><tr><td></td><td><span class="tsco"></span></td></tr></table>`;
const options = {
  date: '2026-10-22',
  roster: [
    { name: 'Synthetic A', country: 'FRA' },
    { name: 'Synthetic B', country: 'ITA' },
  ],
  requireComplete: false,
};
test('exempts : conserver numéro officiel du tableau et pays sans créer de match', () => {
  const result = parseTable(html(), options);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.byes, [
    { round: 'T4', pos: 1, name: 'Synthetic A', seed: 1, country: 'FRA' },
    { round: 'T4', pos: 2, name: 'Synthetic B', seed: 2, country: 'ITA' },
  ]);
});
test('numéro et pays absents : ne pas utiliser rang d’engagement ni pays inventé', () => {
  const result = parseTable(html(null, ''), {
    ...options,
    roster: [{ name: 'Synthetic A', entryRanking: 99 }, { name: 'Synthetic B' }],
  });
  assert.deepEqual(result.byes[0], { round: 'T4', pos: 1, name: 'Synthetic A' });
});
