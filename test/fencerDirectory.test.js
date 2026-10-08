const { test } = require('node:test');
const assert = require('node:assert/strict');
const { directory, search } = require('../src/services/fencerDirectory');
const event = (id, podiumRoster, podiumFormat = 'INDIVIDUAL') => ({
  id,
  name: `Épreuve ${id}`,
  podiumRoster,
  podiumFormat,
});
const athlete = (id, name = 'MARTIN Léa', country = 'FRA', club = 'CEP') => ({ id, name, country, club });
test('regroupement cadet/junior, catégories et favori reconnu sans changer l’épreuve', () => {
  const rows = directory(
    [event(1, [athlete('c')]), event(2, [athlete('j', 'Martin Lea')])],
    [{ ...athlete('c'), id: 42, originCompetitionId: 1, originEntryId: 'c' }],
    { name: 'CEP' },
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].events.map((e) => e.id),
    [1, 2],
  );
  assert.equal(rows[0].favoriteId, 42);
  assert.equal(rows[0].isClub, true);
});
test('homonymes et identités insuffisantes restent distincts ; équipes exclues', () => {
  const rows = directory(
    [
      event(1, [athlete('a'), athlete('b'), athlete('it', undefined, 'ITA'), athlete('none', 'SANS Info', '', '')]),
      event(2, [athlete('none2', 'SANS Info', '', '')]),
      event(3, [athlete('team')], 'TEAM'),
    ],
    [],
    { fencers: ['MARTIN Léa'] },
  );
  assert.equal(rows.length, 5);
  assert.ok(rows.filter((a) => a.name === 'MARTIN Léa').every((a) => !a.isClub));
  assert.ok(rows.every((a) => a.events.every((e) => e.id !== 3)));
});
test('recherche accentuée, pagination, épreuve hors tournoi refusée et lecture sans écritures', async () => {
  const competitions = [
    event(
      1,
      Array.from({ length: 25 }, (_, i) => athlete(String(i), `DUPONT Élodie ${i}`)),
    ),
  ];
  const db = {
    tournament: { findUnique: async () => ({ id: 1 }) },
    competition: {
      findMany: async ({ where }) => {
        assert.equal(where.tournamentId, 1);
        return competitions;
      },
    },
    followedFencer: {
      findMany: async ({ where }) => {
        assert.equal(where.userId, 7);
        return [];
      },
    },
    appSetting: { findUnique: async () => null },
  };
  const args = { tournamentId: 1, query: 'elodie', offset: 0 };
  const first = await search(db, 7, args);
  assert.equal(first.total, 25);
  assert.equal(first.results.length, 20);
  assert.equal(first.nextOffset, 20);
  const last = await search(db, 7, { ...args, offset: 20 });
  assert.equal(last.results.length, 5);
  assert.equal(last.nextOffset, null);
  assert.equal((await search(db, 7, { ...args, query: 'e' })).results.length, 0);
  await assert.rejects(search(db, 7, { ...args, competitionId: 99 }), { status: 400 });
});
