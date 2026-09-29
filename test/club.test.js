const { test } = require('node:test');
const assert = require('node:assert/strict');
const club = require('../src/services/club');

test('club fencers: names normalised, duplicates and blanks removed, limits enforced', () => {
  const c = club.validateClub({
    name: ' Cercle des Escrimeurs Parisiens ',
    fencers: 'SAVIN Rafael\n\n  savin   rafaël \nBEM Maciej',
  });
  assert.deepEqual(c, { name: 'Cercle des Escrimeurs Parisiens', fencers: ['SAVIN Rafael', 'BEM Maciej'] });
  assert.equal(club.normalizeName('Savin  Rafaël'), club.normalizeName('SAVIN Rafael'));
  assert.throws(() => club.validateClub({ name: 'x'.repeat(61) }), /60 caractères/);
  assert.throws(() => club.validateClub({ name: 'C', fencers: Array.from({ length: 301 }, (_, i) => `T${i}`) }), /300/);
});

function fakeDb({ start, previousMembers = [], otherClub = [] }) {
  const leagues = [
    { id: 1, kind: 'CLUB', name: 'CEP', tournamentId: 1, members: previousMembers.map((userId) => ({ userId })) },
  ];
  const members = [];
  return {
    leagues,
    members,
    appSetting: { findUnique: async () => ({ value: { name: 'CEP', fencers: [] } }) },
    tournament: {
      findMany: async () => [
        { id: 1, competitions: [] },
        { id: 2, competitions: [{ id: 20 }] },
      ],
    },
    league: {
      findFirst: async ({ where }) => {
        if (where.NOT) return leagues.filter((l) => l.id !== where.NOT.id && l.name === where.name).at(-1) || null;
        return leagues.find((l) => l.tournamentId === where.tournamentId && l.name === where.name) || null;
      },
      create: async ({ data }) => {
        const l = { id: leagues.length + 1, members: [], ...data };
        leagues.push(l);
        return l;
      },
    },
    leagueMember: {
      findFirst: async ({ where }) => (otherClub.includes(where.userId) ? { id: 99 } : null),
      create: async ({ data }) => members.push(data),
    },
    match: { findFirst: async () => (start ? { startsAt: start } : null) },
    user: { findFirst: async () => ({ id: 3 }) },
    competition: { findUnique: async () => null },
  };
}

test('club league created for a new tournament with a known start; club members carried over', async () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const db = fakeDb({ start: new Date('2026-10-10T08:00:00Z'), previousMembers: [5, 6, 7], otherClub: [7] });
  const created = await club.ensureClubLeagues(db, { now });
  assert.deepEqual(created, [{ tournamentId: 2, leagueId: 2, carried: 2 }]);
  assert.equal(db.leagues[1].name, 'CEP');
  assert.equal(db.leagues[1].kind, 'CLUB');
  assert.equal(db.leagues[1].ownerId, 3);
  assert.deepEqual(
    db.members.map((m) => m.userId),
    [5, 6],
    'a player already in another club for this tournament is not moved',
  );
  assert.deepEqual(await club.ensureClubLeagues(db, { now }), [], 'idempotent');
});

test('no club league without a known start, after the start, or without a club name', async () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual(await club.ensureClubLeagues(fakeDb({ start: null }), { now }), []);
  assert.deepEqual(await club.ensureClubLeagues(fakeDb({ start: new Date('2026-09-30T08:00:00Z') }), { now }), []);
  const unnamed = fakeDb({ start: new Date('2026-10-10T08:00:00Z') });
  unnamed.appSetting.findUnique = async () => null;
  assert.deepEqual(await club.ensureClubLeagues(unnamed, { now }), []);
});
