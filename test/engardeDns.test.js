// Forfait avant le début de poule sur engarde-service (Circuit Antony, poule 3 du fleuret hommes) :
// le tireur « DNS » a tous ses assauts à F, les autres ont X contre lui.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/services/engardeParser');

const grid = [
  ['MIDELTON Enzo', 'FRA', ['', 'V', '2', '3', '1', 'X', 'V'], ['0.400', '-3', '16']],
  ['BLOKKER Szymon', 'NED', ['3', '', '3', '2', '0', 'X', 'V'], ['0.200', '-7', '13']],
  ['AHLVERS Max', 'GER', ['V', 'V', '', '3', '0', 'X', '2'], ['0.400', '-5', '15']],
  ['HECHER Benoit', 'FRA', ['V', 'V', 'V', '', 'V', 'X', 'V'], ['1.000', '12', '25']],
  ['SIDO Alexandre', 'FRA', ['V', 'V', 'V', '2', '', 'X', 'V'], ['0.800', '14', '22']],
  ['GREGOIRE Gabriel', 'FRA', ['F', 'F', 'F', 'F', 'F', '', 'F'], ['DNS', '', '']],
  ['NATIVELLE Alex', 'FRA', ['1', '0', 'V', '3', '2', 'X', ''], ['0.200', '-11', '11']],
];
const pool = (number, rows) =>
  `<p>Poule No ${number} - 09:00 - Piste 3 - Arbitre : X</p><table class="poule"><tr><th>Poule No ${number}</th><th></th><th></th>${rows
    .map(() => '<th></th>')
    .join('')}<th></th><th>V/M</th><th>Indice</th><th>TD</th></tr>${rows
    .map(
      ([name, club, cells, stats]) =>
        `<tr><td>${name}</td><td><span class="club">${club}</span></td><td></td>${cells
          .map((c) => `<td>${c}</td>`)
          .join('')}<td></td>${stats.map((s) => `<td>${s}</td>`).join('')}</tr>`,
    )
    .join('')}</table>`;

test('engarde : tireur DNS absent de la poule, bilans des autres sans ses assauts', () => {
  const [p] = E.parsePools(pool(3, grid));
  assert.equal(p.error, undefined);
  assert.equal(p.complete, true);
  const by = Object.fromEntries(p.rows.map((r) => [r.name, r]));
  assert.equal(by['GREGOIRE Gabriel'].absent, true);
  assert.equal(by['GREGOIRE Gabriel'].wins, null);
  assert.deepEqual([by['HECHER Benoit'].wins, by['HECHER Benoit'].losses, by['HECHER Benoit'].indicator], [5, 0, 12]);
  assert.deepEqual([by['MIDELTON Enzo'].wins, by['MIDELTON Enzo'].indicator], [2, -3]);
  assert.deepEqual([by['NATIVELLE Alex'].wins, by['NATIVELLE Alex'].losses], [1, 4]);
});

test('engarde : une poule illisible est signalée seule, les autres sont importées', () => {
  const broken = grid.map((r, i) => (i === 0 ? [r[0], r[1], ['', 'V', '2', 'Ab', '1', 'X', 'V'], r[3]] : r));
  const pools = E.parsePools(pool(3, grid) + pool(4, broken));
  assert.equal(pools.length, 2);
  assert.equal(pools[0].error, undefined);
  assert.match(pools[1].error, /poule 4/);
});

test('engarde : apostrophe doublée ramenée à une seule', () => {
  const renamed = grid.map((r, i) => (i === 1 ? ["ROSSI Nicolo''", 'ITA', r[2], r[3]] : r));
  const [p] = E.parsePools(pool(33, renamed));
  assert.equal(p.rows[1].name, "ROSSI Nicolo'");
});
