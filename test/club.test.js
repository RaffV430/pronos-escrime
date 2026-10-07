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

const groups = require('../src/services/groups');
const at = (d) => new Date(`2026-10-${d}T10:00:00Z`);

test('club permanent : membres comptés selon leur présence au début du tournoi', () => {
  const members = [
    { userId: 1, joinedAt: at('01'), leftAt: null },
    { userId: 2, joinedAt: at('12'), leftAt: null }, // arrivé après le début
    { userId: 3, joinedAt: at('01'), leftAt: at('09') }, // parti avant le début
    { userId: 4, joinedAt: at('01'), leftAt: at('15') }, // parti après le début : compte encore
  ];
  const now = at('20').getTime();
  assert.deepEqual(
    groups.clubMembersAt(members, at('10'), now).map((m) => m.userId),
    [1, 4],
  );
  // Tournoi pas encore commencé (ou sans horaire) : les membres actuels.
  assert.deepEqual(
    groups.clubMembersAt(members, at('25'), now).map((m) => m.userId),
    [1, 2],
  );
  assert.deepEqual(
    groups.clubMembersAt(members, null, now).map((m) => m.userId),
    [1, 2],
  );
  // Groupe d'amis : toujours les membres actuels, quel que soit le tournoi.
  const friends = { kind: 'PRIVATE', members };
  assert.deepEqual(
    groups.membersFor(friends, { start: at('10'), tournamentId: 5, now }).map((m) => m.userId),
    [1, 2],
  );
});

test('un seul club à la fois ; retour dans un groupe après un départ', async () => {
  let upsert;
  const tx = (other) => ({
    $queryRaw: async () => [],
    leagueMember: {
      findFirst: async () => other,
      findUnique: async () => null,
      upsert: async (q) => (upsert = q),
    },
  });
  await assert.rejects(
    groups.enroll(tx({ league: { name: 'Club A' } }), { id: 2, kind: 'CLUB' }, 7),
    /Un seul club à la fois : quittez d’abord « Club A »/,
  );
  await groups.enroll(tx(null), { id: 2, kind: 'CLUB' }, 7);
  assert.deepEqual(upsert.update, { leftAt: null });
  await assert.rejects(groups.enroll(tx(null), { id: 3, kind: 'PRIVATE', archivedAt: new Date() }, 7), /n’existe plus/);
});

test('club de l’application : anciennes ligues par tournoi fusionnées dans la plus récente', async () => {
  const leagues = [
    { id: 9, members: [{ id: 91, userId: 1, joinedAt: at('05'), leftAt: null }] },
    {
      id: 4,
      members: [
        { id: 41, userId: 1, joinedAt: at('01'), leftAt: null },
        { id: 42, userId: 2, joinedAt: at('02'), leftAt: null },
      ],
    },
  ];
  const writes = [];
  const db = {
    appSetting: { findUnique: async () => ({ value: { name: 'CEP', fencers: [] } }) },
    league: {
      findMany: async () => leagues,
      updateMany: async (q) => writes.push(['archive', q.where.id.in]),
    },
    leagueMember: {
      update: async (q) => writes.push(['update', q.where.id, q.data.joinedAt.toISOString().slice(0, 10)]),
      create: async (q) => writes.push(['create', q.data.leagueId, q.data.userId]),
    },
  };
  db.$transaction = (fn) => fn(db);
  const kept = await groups.ensureAppClub(db);
  assert.equal(kept.id, 9);
  assert.deepEqual(writes, [
    ['update', 91, '2026-10-01'],
    ['create', 9, 2],
    ['archive', [4]],
  ]);
});
