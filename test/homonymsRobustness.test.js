// Homonymes sur engarde-service : deux engagés du même nom restent deux tireurs dès que leur club ou leur
// numéro de série d'entrée diffère (Journées de l'épée 2026, deux « ROBERT Julien »).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/services/engardeParser');
const { entryFor, mergeRoster } = require('../src/services/engardeRoster');
const { addLateEntrants } = require('../src/services/engardeSync');
const { planRecomposition } = require('../src/services/poolRecompose');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'engarde', name), 'utf8');
const ROW = '<tr><td class="GBD"> 1 </td><td class="BD"> 1002 </td><td class="BD"> BOLORE </td>';

test('liste des engagés : même nom et même club, numéros de série différents = deux engagés', () => {
  const html = fixture('fdm20-tireurs-extrait.html');
  const first = html.indexOf(ROW);
  const row = html.slice(first, html.indexOf('</tr>', first) + 5);
  const twin = row.replace('> 1 <', '> 99 <').replace('> 1002 <', '> 1999 <');
  const roster = E.parseRoster(html.replace(row, row + twin));
  const bolore = roster.filter((e) => e.name === 'BOLORE Mélisande');
  assert.equal(bolore.length, 2);
  assert.notEqual(bolore[0].id, bolore[1].id);
  // Le premier garde l'identifiant habituel : pronostics déjà enregistrés conservés.
  assert.equal(bolore[0].id, E.parseRoster(html).find((e) => e.name === 'BOLORE Mélisande').id);
  // Liste déjà enregistrée : l'engagé connu garde son identifiant, le second est ajouté.
  const merged = mergeRoster(E.parseRoster(html), roster).merged.filter((e) => e.name === 'BOLORE Mélisande');
  assert.deepEqual(
    merged.map((e) => e.active),
    [true, true],
  );
  // Même nom, même club : jamais attribué au hasard (poules et matchs mis de côté pour vérification).
  assert.equal(entryFor(roster, 'BOLORE Mélisande', 'ANTONY'), null);
  // Même numéro de série répété : vraie inscription en double, refusée.
  assert.throws(() => E.parseRoster(html.replace(row, row + row)), /Engagés en double/);
});

test('poule : deux homonymes de clubs différents dans la même poule, bilans propres à chacun', () => {
  const html = fixture('fdm20-poules-1-2.html');
  const twins = html.replace('<td>CAUVET Clarisse</td>', '<td>MARCEL VU Elisa</td>');
  assert.notEqual(twins, html);
  const [pool] = E.parsePools(twins);
  assert.equal(pool.error, undefined);
  const elisa = pool.rows.filter((r) => r.name === 'MARCEL VU Elisa');
  assert.deepEqual(
    elisa.map((r) => [r.club, r.position]),
    [
      ['BLR92', 1],
      ['PARIS CEP', 3],
    ],
  );
  const before = E.parsePools(html)[0].rows;
  assert.deepEqual(
    elisa.map((r) => r.wins),
    [before[0].wins, before[2].wins],
  );
  // Poule enregistrée avec les clubs : même composition reconnue, rien à recomposer.
  const stored = {
    id: 1,
    sourceUrl: 'u',
    sourcePoolNumber: pool.number,
    // Poule pas encore commencée dans l'application.
    fencers: pool.rows.map((r) => ({
      name: r.name,
      club: r.club,
      position: r.position,
      wins: null,
      losses: null,
      indicator: null,
    })),
  };
  assert.equal(
    planRecomposition([stored], 'u', [pool], [], undefined, () => ({})),
    null,
  );
  // Les deux homonymes échangent leur place : poule réordonnée (pronostics conservés), pas « changée ».
  const swapped = {
    ...pool,
    rows: pool.rows.map((r, i) =>
      i === 0 ? { ...pool.rows[2], position: 1 } : i === 2 ? { ...pool.rows[0], position: 3 } : r,
    ),
  };
  const plan = planRecomposition([stored], 'u', [swapped], [], undefined, () => ({}));
  assert.equal(plan.reordered.length, 1);
  assert.equal(plan.changed.length, 0);
});

test('engagé de dernière minute homonyme d’un autre club : ajouté, pas confondu', async () => {
  const c = {
    id: 28,
    podiumRoster: [{ id: 'd', name: 'ROBERT Julien', country: 'DECINES TE', active: true }],
  };
  const tx = {
    $queryRaw: async () => [],
    competition: {
      findUnique: async () => ({ podiumRoster: c.podiumRoster }),
      update: async ({ data }) => ({ podiumRoster: data.podiumRoster }),
    },
    auditLog: { create: async () => {} },
  };
  const db = { $transaction: (fn) => fn(tx) };
  await addLateEntrants(db, c, [
    { name: 'ROBERT Julien', club: 'DECINES TE' },
    { name: 'ROBERT Julien', club: 'PERPIGNAN RO' },
  ]);
  assert.deepEqual(
    c.podiumRoster.map((e) => e.country),
    ['DECINES TE', 'PERPIGNAN RO'],
  );
  assert.equal(entryFor(c.podiumRoster, 'ROBERT Julien', 'PERPIGNAN RO').country, 'PERPIGNAN RO');
});
