const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, freshDatabase } = require('./helpers');
const { PrismaClient } = require('@prisma/client');
const clubs = require('../../src/services/accountClubs');
const moderation = require('../../src/services/clubModeration');
const mail = require('../../src/services/clubRequestMail');
let db;
const options = { skip: !url && 'TEST_DATABASE_URL non défini' };
before(async () => {
  if (url) db = new PrismaClient({ datasourceUrl: await freshDatabase('club_moderation') });
});
after(async () => {
  await db?.$disconnect();
});
async function user(name, isAdmin = false) {
  return db.user.create({ data: { name, email: `${name}@example.test`, password: 'test-only', isAdmin } });
}
test(
  'pending club does not create directory entries; approval enrolls once and cancelled requests cannot overwrite choice',
  options,
  async () => {
    const a = await user('a'),
      admin = await user('admin', true);
    const p = await clubs.setClub(db, a.id, { name: 'Nouveau Club', city: 'Paris' });
    assert.equal(p.club, null);
    assert.equal(p.clubRequest.status, 'PENDING');
    assert.ok(p.clubChoiceAt);
    assert.equal(await db.club.count({ where: { nameKey: 'nouveau club' } }), 0);
    assert.equal(await db.leagueMember.count({ where: { userId: a.id } }), 0);
    await assert.rejects(moderation.decide(db, a.id, p.clubRequest.id, { status: 'APPROVED' }), { status: 403 });
    await assert.rejects(moderation.decide(db, admin.id, p.clubRequest.id, { status: 'REJECTED', reason: '' }), {
      status: 400,
    });
    assert.equal((await clubs.profile(db, a.id)).clubRequest.status, 'PENDING');
    await Promise.all([
      moderation.decide(db, admin.id, p.clubRequest.id, { status: 'APPROVED' }),
      moderation.decide(db, admin.id, p.clubRequest.id, { status: 'APPROVED' }),
    ]);
    const approved = await clubs.profile(db, a.id);
    assert.ok(approved.club);
    assert.equal(approved.club.status, 'VERIFIED');
    assert.equal(await db.leagueMember.count({ where: { userId: a.id, leftAt: null } }), 1);
    const next = await clubs.setClub(db, a.id, { name: 'Autre Club', city: 'Lyon' });
    await clubs.setClub(db, a.id, { clubId: approved.club.id });
    await assert.rejects(moderation.decide(db, admin.id, next.clubRequest.id, { status: 'APPROVED' }), { status: 409 });
    assert.equal((await clubs.profile(db, a.id)).club.id, approved.club.id);
  },
);
test(
  'rules revision, automatic rejection, manual reason and queued mail failures preserve the account',
  options,
  async () => {
    const admin = await user('rules-admin', true),
      a = await user('rules-user');
    const p = await moderation.policy(db);
    await moderation.updatePolicy(db, admin.id, {
      revision: p.revision,
      csv: 'terme;categorie;action\ninterdit;injures_graves;bloquer\nambigu;grossieretes;revoir',
      rules: moderation.DEFAULT_RULES,
    });
    await assert.rejects(
      moderation.updatePolicy(db, admin.id, { revision: 0, terms: [], rules: moderation.DEFAULT_RULES }),
      { status: 409 },
    );
    const r = await clubs.setClub(db, a.id, { name: 'Club interdit', city: 'Paris' });
    assert.equal(r.club, null);
    assert.equal(r.clubRequest.status, 'REJECTED');
    assert.equal(r.clubRequest.mailStatus, 'PENDING');
    assert.match(r.clubRequest.reason, /injures graves/);
    assert.equal(await db.club.count({ where: { nameKey: 'club interdit' } }), 0);
    assert.equal(await mail.deliver(db, { playerMailAvailable: () => false }), 0);
    const now = new Date();
    await mail.deliver(
      db,
      {
        playerMailAvailable: () => true,
        sendMail: async () => {
          throw new Error('provider down');
        },
      },
      now,
    );
    const retry = await db.clubRegistrationRequest.findUnique({ where: { id: r.clubRequest.id } });
    assert.equal(retry.mailStatus, 'PENDING');
    assert.equal(retry.mailAttempts, 1);
    let sent;
    await mail.deliver(
      db,
      {
        playerMailAvailable: () => true,
        sendMail: async (input) => {
          sent = input;
        },
      },
      new Date(now.getTime() + 11 * 60000),
    );
    assert.ok(sent.text.includes(r.clubRequest.reason));
    assert.equal(sent.idempotencyKey, `club-request-refused-${r.clubRequest.id}`);
    assert.equal((await db.clubRegistrationRequest.findUnique({ where: { id: r.clubRequest.id } })).mailStatus, 'SENT');
    assert.equal(
      await mail.deliver(db, {
        playerMailAvailable: () => true,
        sendMail: async () => {
          throw new Error('must not repeat');
        },
      }),
      0,
    );
    const pending = await clubs.setClub(db, a.id, { name: 'Club normal', city: 'Tours' });
    await moderation.decide(db, admin.id, pending.clubRequest.id, {
      status: 'REJECTED',
      reason: 'Club introuvable dans les sources fournies.',
    });
    assert.equal((await clubs.profile(db, a.id)).clubRequest.reason, 'Club introuvable dans les sources fournies.');
    await db.clubRegistrationRequest.update({
      where: { id: pending.clubRequest.id },
      data: { mailStatus: 'SENDING', mailAttempts: 5, mailNextAt: now },
    });
    await mail.deliver(
      db,
      {
        playerMailAvailable: () => true,
        sendMail: async () => {
          throw new Error('exhausted request must not resend');
        },
      },
      now,
    );
    assert.equal((await clubs.profile(db, a.id)).clubRequest.mailStatus, 'FAILED');
    const close = await clubs.setClub(db, a.id, { name: 'Club interdiit', city: 'Paris' });
    assert.equal(close.clubRequest.status, 'PENDING');
    assert.match(close.clubRequest.reason, /ressemblance/);
    assert.equal(close.clubRequest.mailStatus, 'NONE');
    assert.equal(close.club, null);
    await moderation.decide(db, admin.id, close.clubRequest.id, { status: 'APPROVED' });
    assert.ok((await clubs.profile(db, a.id)).club);
    const review = await clubs.setClub(db, a.id, { name: 'Club ambigu', city: 'Tours' });
    assert.equal(review.clubRequest.status, 'PENDING');
    assert.match(review.clubRequest.reason, /terme à revoir/);
  },
);
