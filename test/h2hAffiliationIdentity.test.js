const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headToHead } = require('../src/services/headToHead');

const name = 'EXEMPLE Alex';
const opponent = 'AUTRE Camille';
const competition = (country, affiliationId = 10, extra = {}) => ({
  name: 'Épreuve de test',
  tournament: { name: 'Tournoi fictif' },
  podiumRoster: [
    { id: 'a', name, country },
    { id: 'b', name: opponent, country: 'ITA' },
  ],
  affiliationEntries: affiliationId ? [{ entryId: 'a', affiliationId, affiliation: { country: 'FRA' } }] : [],
  ...extra,
});
const bout = (id, comp, reverse = false) => ({
  id,
  player1: reverse ? opponent : name,
  player2: reverse ? name : opponent,
  score1: 15,
  score2: 9,
  winner: 1,
  round: 'T32',
  competition: comp,
});
function database(current, rows, calls = []) {
  // Aucun modèle de pronostics/points ni méthode d’écriture : toute écriture ferait échouer le test.
  return {
    match: {
      findUnique: async () => bout(999, current),
      findMany: async (args) => {
        calls.push(args);
        const start = args.cursor ? rows.findIndex((m) => m.id === args.cursor.id) + args.skip : 0;
        return rows.slice(start, start + args.take);
      },
    },
    pool: { findMany: async () => [] },
  };
}
test('a linked identity joins national club and international country in both directions', async () => {
  for (const [current, past] of [
    ['FRA', 'CLUB FICTIF'],
    ['CLUB FICTIF', 'FRA'],
  ]) {
    const rows = [bout(5, competition(past)), bout(4, competition(past), true)];
    const before = JSON.stringify(rows);
    const result = await headToHead(database(competition(current), rows), 999);
    assert.deepEqual(
      result.form.player1.map((r) => [r.matchId, r.won, r.score]),
      [
        [5, true, [15, 9]],
        [4, false, [9, 15]],
      ],
    );
    assert.equal(result.meetings.length, 2);
    assert.equal(JSON.stringify(rows), before);
    assert.equal('affiliationId' in result.form.player1[0], false);
  }
});
test('unlinked clubs, conflicting nations, distinct identities and ambiguous rosters are not merged', async () => {
  const rows = [
    bout(9, competition('CLUB FICTIF', null)),
    bout(8, competition('ITA', null)),
    bout(7, competition('FRA', 20)),
    bout(
      6,
      competition('FRA', 10, {
        podiumRoster: [
          { id: 'a', name, country: 'FRA' },
          { id: 'c', name, country: 'FRA' },
        ],
      }),
    ),
    // Même lien mais nation officielle contradictoire : ne pas masquer une incohérence.
    bout(5, competition('ITA', 10)),
    bout(4, competition('FRA', 10)),
  ];
  const result = await headToHead(database(competition('FRA'), rows), 999);
  assert.deepEqual(
    result.form.player1.map((m) => m.matchId),
    [4],
  );
  assert.deepEqual(
    result.meetings.map((m) => m.matchId),
    [4],
  );
});
test('five eligible results are selected after identity filtering, across query pages', async () => {
  const rows = Array.from({ length: 27 }, (_, i) => bout(100 - i, competition('ITA', null)));
  rows.push(...Array.from({ length: 7 }, (_, i) => bout(73 - i, competition('CLUB FICTIF'))));
  const calls = [];
  const result = await headToHead(database(competition('FRA'), rows, calls), 999);
  assert.deepEqual(
    result.form.player1.map((m) => m.matchId),
    [73, 72, 71, 70, 69],
  );
  assert.equal(result.meetings.length, 7);
  assert.ok(calls.some((c) => c.cursor && c.skip === 1));
  for (const c of calls) {
    assert.ok(c.where.AND.some((v) => v.pointsPending === false));
    assert.ok(c.where.AND.some((v) => v.id?.not === 999));
    assert.ok(JSON.stringify(c.where).includes('CANCELLED'));
    assert.ok(c.take <= 25);
  }
});
test('a history read failure is propagated rather than presenting a partial success', async () => {
  const db = database(competition('FRA'), []);
  db.match.findMany = async () => {
    throw new Error('lecture indisponible');
  };
  await assert.rejects(headToHead(db, 999), /lecture indisponible/);
});
