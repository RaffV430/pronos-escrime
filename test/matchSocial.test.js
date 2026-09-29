const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/services/matchSocial');

test('comments are cleaned, limited to 280 characters and throttled per player', () => {
  assert.equal(s.cleanText('  Allez  ​ le club !\n\n\n\nBravo  '), 'Allez   le club !\n\nBravo');
  assert.throws(() => s.cleanText('   '), /vide/);
  assert.throws(() => s.cleanText('x'.repeat(281)), /280/);
  s._recent.clear();
  const now = Date.now();
  for (let i = 0; i < 5; i++) s.throttle(42, now + i);
  assert.throws(() => s.throttle(42, now + 10), /Patientez/);
  assert.doesNotThrow(() => s.throttle(42, now + 61000), 'allowed again after a minute');
  assert.doesNotThrow(() => s.throttle(43, now + 10), 'other players unaffected');
});

function db() {
  const reactions = [],
    comments = [],
    audits = [];
  return {
    reactions,
    comments,
    audits,
    match: { findUnique: async ({ where }) => (where.id === 1 ? { id: 1 } : null) },
    user: { findUnique: async ({ where }) => ({ isAdmin: where.id === 9 }) },
    matchReaction: {
      upsert: async ({ where, create, update }) => {
        const r = reactions.find(
          (x) => x.matchId === where.matchId_userId.matchId && x.userId === where.matchId_userId.userId,
        );
        if (r) Object.assign(r, update);
        else reactions.push({ ...create });
      },
      deleteMany: async ({ where }) =>
        reactions.splice(
          reactions.findIndex((x) => x.userId === where.userId),
          1,
        ),
    },
    matchComment: {
      create: async ({ data }) => {
        const c = { id: comments.length + 1, createdAt: new Date(), hiddenAt: null, ...data };
        comments.push(c);
        return c;
      },
      findUnique: async ({ where }) => comments.find((c) => c.id === where.id) || null,
      update: async ({ where, data }) =>
        Object.assign(
          comments.find((c) => c.id === where.id),
          data,
        ),
    },
    auditLog: { create: async ({ data }) => audits.push(data) },
  };
}

test('one reaction per player (changeable, removable), whitelist of emojis', async () => {
  const d = db();
  assert.equal(await s.react(d, 1, 5, '👏'), '👏');
  assert.equal(await s.react(d, 1, 5, '🔥'), '🔥');
  assert.equal(d.reactions.length, 1);
  assert.equal(d.reactions[0].emoji, '🔥');
  await s.react(d, 1, 5, null);
  assert.equal(d.reactions.length, 0);
  await assert.rejects(s.react(d, 1, 5, '💩'), /inconnue/);
  await assert.rejects(s.react(d, 2, 5, '👏'), /introuvable/);
});

test('a comment can be hidden by its author or an admin (logged), never by another player', async () => {
  s._recent.clear();
  const d = db();
  const c = await s.comment(d, 1, 5, 'Allez Rafael !');
  await assert.rejects(s.hide(d, 1, c.id, { userId: 6 }), /auteur ou un administrateur/);
  await s.hide(d, 1, c.id, { userId: 9 });
  assert.ok(d.comments[0].hiddenAt);
  assert.equal(d.audits[0].action, 'Commentaire masqué (modération)');
  assert.equal(d.audits[0].before.text, 'Allez Rafael !');
  const own = await s.comment(d, 1, 5, 'Oups');
  await s.hide(d, 1, own.id, { userId: 5 });
  assert.equal(d.audits.length, 1, 'an author removing their own comment is not a moderation action');
  await assert.rejects(s.hide(d, 1, own.id, { userId: 5 }), /introuvable/, 'already hidden');
});
