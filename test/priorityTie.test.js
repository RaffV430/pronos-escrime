// Épée : égalité à la fin du temps, victoire à la priorité avec le même score (« V3 » face à « 3 »).
// Journées de l'épée 2026, épée dames M17, poule 24 : TRONCHE Yoela-Elie V3 / SEREZAT Zoe 3.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const E = require('../src/services/engardeParser');
const F = require('../src/services/ftlPools');

const fixture = (...p) => fs.readFileSync(path.join(__dirname, 'fixtures', ...p), 'utf8');

test('engarde : victoire à la priorité à égalité de touches acceptée, bilans justes', () => {
  const html = fixture('engarde', 'fdm20-poules-1-2.html');
  // MARCEL VU « V4 » contre CHEVREAU : 3 → 4 (égalité, priorité à MARCEL VU).
  const tie = html.replace(
    '<td>CHEVREAU Clementine</td><td><span class="club">PARIS RCF</span></td><td></td><td class="GBD">3</td>',
    '<td>CHEVREAU Clementine</td><td><span class="club">PARIS RCF</span></td><td></td><td class="GBD">4</td>',
  );
  assert.notEqual(tie, html);
  const pool = E.parsePools(tie)[0];
  assert.equal(pool.error, undefined);
  assert.equal(pool.bouts[6][0], 'D4');
  const row = (name) => pool.rows.find((r) => r.name === name);
  assert.equal(row('MARCEL VU Elisa').wins, 4);
  assert.equal(row('CHEVREAU Clementine').wins, 3);
  // Victoire sans touches publiées (« V ») face à 5 : toujours incohérent.
  const bad = html.replace(
    '<td>CHEVREAU Clementine</td><td><span class="club">PARIS RCF</span></td><td></td><td class="GBD">3</td>',
    '<td>CHEVREAU Clementine</td><td><span class="club">PARIS RCF</span></td><td></td><td class="GBD">5</td>',
  );
  assert.match(E.parsePools(bad)[0].error, /Scores réciproques incohérents/);
});

test('FencingTimeLive : « V4 » / « D4 » (priorité) accepté, « V4 » / « D5 » refusé', () => {
  const $ = load(fixture('ftl-pools.html'));
  $('table.poolTable').slice(1).parent().remove();
  const first = () => $('table.poolTable').first().find('tr').eq(1).find('td.poolScore').first().find('span');
  assert.equal(first().text().trim(), 'D1');
  first().text('D4');
  // Totaux mis à jour : PRATS marque 3 touches de plus (24 → 27, +5 → +8), son adversaire en reçoit 3 de plus.
  const stats = (i) => $('table.poolTable').first().find('tr').eq(i).find('td.poolResult');
  stats(1).eq(2).text('27');
  stats(1).eq(4).text('+8');
  stats(2).eq(3).text('10');
  stats(2).eq(4).text('+17');
  const pool = F.parsePools($.html())[0];
  assert.equal(pool.bouts[0][1], 'D4');
  assert.equal(pool.bouts[1][0], 'V4');
  // Vaincu avec plus de touches que le vainqueur : incohérent.
  first().text('D5');
  stats(1).eq(2).text('28');
  stats(1).eq(4).text('+9');
  stats(2).eq(3).text('11');
  stats(2).eq(4).text('+16');
  assert.throws(() => F.parsePools($.html()), /Scores réciproques incohérents/);
});

test('engarde : entités restées échappées dans les noms décodées (« Chlo&#279; » = « Chloė »)', () => {
  assert.equal(E.clean('QUENON Chlo&#279;'), 'QUENON Chloė');
  assert.equal(E.clean('ROSSI Nicol&#xF2;'), 'ROSSI Nicolò');
  assert.equal(E.clean('A &#99999999; B'), 'A &#99999999; B');
});
