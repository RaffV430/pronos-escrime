const { test } = require('node:test');
const assert = require('node:assert/strict');
const invites = require('../src/services/delegationInvites');

// Base en mémoire : juste ce que les invitations et l'adhésion utilisent.
function fakeDb() {
  const users = [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bruno' },
    { id: 3, name: 'Chloé' },
  ];
  const leagues = [
    { id: 10, name: 'Les amis', kind: 'PRIVATE', archivedAt: null },
    { id: 20, name: 'Club', kind: 'CLUB', archivedAt: null },
  ];
  const members = [
    { id: 1, leagueId: 10, userId: 1, leftAt: null, joinedAt: new Date() },
    { id: 2, leagueId: 20, userId: 1, leftAt: null, joinedAt: new Date() },
  ];
  const invitations = [];
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  const memberMatch = (m, w) =>
    (w.leagueId === undefined || m.leagueId === w.leagueId) &&
    (w.userId === undefined || m.userId === w.userId) &&
    (!('leftAt' in w) || m.leftAt === w.leftAt);
  return {
    invitations,
    members,
    $queryRaw: async () => [],
    user: {
      findUnique: async ({ where, select }) => {
        const u = users.find((x) => x.name === where.name || x.id === where.id);
        return u ? pick(u, select) : null;
      },
      findMany: async ({ where, select }) =>
        users
          .filter((u) =>
            where.id ? where.id.in.includes(u.id) : u.name.toLowerCase() === where.name.equals.toLowerCase(),
          )
          .map((u) => pick(u, select)),
      update: async () => ({}),
    },
    league: { findUnique: async ({ where }) => leagues.find((l) => l.id === where.id) || null },
    leagueMember: {
      findFirst: async ({ where }) => members.find((m) => memberMatch(m, where)) || null,
      findUnique: async ({ where }) =>
        members.find(
          (m) => m.leagueId === where.leagueId_userId.leagueId && m.userId === where.leagueId_userId.userId,
        ) || null,
      upsert: async ({ where, update, create }) => {
        const { leagueId, userId } = where.leagueId_userId;
        const row = members.find((m) => m.leagueId === leagueId && m.userId === userId);
        if (row) return Object.assign(row, update);
        const created = { id: members.length + 1, leftAt: null, joinedAt: new Date(), ...create };
        members.push(created);
        return created;
      },
    },
    leagueInvitation: {
      findUnique: async ({ where, include }) => {
        const r = where.id
          ? invitations.find((i) => i.id === where.id)
          : invitations.find(
              (i) => i.leagueId === where.leagueId_userId.leagueId && i.userId === where.leagueId_userId.userId,
            );
        return r && include?.league ? { ...r, league: leagues.find((l) => l.id === r.leagueId) } : r || null;
      },
      count: async ({ where }) => invitations.filter((i) => i.leagueId === where.leagueId).length,
      create: async ({ data }) => {
        const row = { id: invitations.length + 100, createdAt: new Date(), ...data };
        invitations.push(row);
        return row;
      },
      delete: async ({ where }) =>
        invitations.splice(
          invitations.findIndex((i) => i.id === where.id),
          1,
        ),
      deleteMany: async ({ where }) => {
        for (let i = invitations.length - 1; i >= 0; i--)
          if (invitations[i].leagueId === where.leagueId && invitations[i].userId === where.userId)
            invitations.splice(i, 1);
      },
      findMany: async ({ where }) =>
        invitations
          .filter((i) => i.userId === where.userId)
          .map((i) => {
            const l = leagues.find((x) => x.id === i.leagueId);
            return {
              ...i,
              league: {
                id: l.id,
                name: l.name,
                _count: { members: members.filter((m) => m.leagueId === l.id && !m.leftAt).length },
              },
            };
          }),
    },
  };
}
const rejects = (promise, status, pattern) =>
  assert.rejects(promise, (e) => e.status === status && pattern.test(e.message));

test('un membre invite par nom d’utilisateur, sans tenir compte des majuscules', async () => {
  const db = fakeDb();
  assert.deepEqual(await invites.invite(db, 10, 1, '  bruno '), { name: 'Bruno' });
  assert.equal(db.invitations.length, 1);
  assert.equal(db.invitations[0].userId, 2);
  // L'invitation ne fait pas entrer la personne : elle doit accepter.
  assert.equal(db.members.filter((m) => m.leagueId === 10).length, 1);
  const list = await invites.received(db, 2);
  assert.equal(list.length, 1);
  assert.equal(list[0].invitedBy, 'Alice');
  assert.deepEqual(list[0].league, { id: 10, name: 'Les amis', members: 1 });
});

test('refus clairs : inconnu, non-membre, club, déjà membre, déjà invité, soi-même', async () => {
  const db = fakeDb();
  await rejects(invites.invite(db, 10, 1, 'Inconnu'), 404, /Aucun joueur/);
  await rejects(invites.invite(db, 10, 1, ''), 400, /nom d’utilisateur/);
  await rejects(invites.invite(db, 10, 2, 'Chloé'), 403, /privé/);
  await rejects(invites.invite(db, 20, 1, 'Bruno'), 403, /Mon compte/);
  await rejects(invites.invite(db, 10, 1, 'Alice'), 400, /déjà membre/);
  await invites.invite(db, 10, 1, 'Bruno');
  await rejects(invites.invite(db, 10, 1, 'Bruno'), 409, /déjà une invitation/);
});

test('accepter fait entrer dans la délégation ; un nouveau membre peut inviter à son tour', async () => {
  const db = fakeDb();
  await invites.invite(db, 10, 1, 'Bruno');
  const [{ id }] = await invites.received(db, 2);
  await rejects(invites.accept(db, id, 3), 404, /introuvable/);
  assert.deepEqual(await invites.accept(db, id, 2), { id: 10, name: 'Les amis' });
  assert.ok(db.members.some((m) => m.leagueId === 10 && m.userId === 2 && !m.leftAt));
  assert.equal(db.invitations.length, 0);
  assert.deepEqual(await invites.invite(db, 10, 2, 'Chloé'), { name: 'Chloé' });
});

test('refuser supprime l’invitation sans adhésion ; on peut réinviter ensuite', async () => {
  const db = fakeDb();
  await invites.invite(db, 10, 1, 'Bruno');
  const [{ id }] = await invites.received(db, 2);
  await invites.decline(db, id, 2);
  assert.equal(db.invitations.length, 0);
  assert.ok(!db.members.some((m) => m.leagueId === 10 && m.userId === 2));
  await invites.invite(db, 10, 1, 'Bruno');
  await invites.clear(db, 10, 2);
  assert.equal(db.invitations.length, 0);
});
