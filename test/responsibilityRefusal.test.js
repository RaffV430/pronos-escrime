const test = require('node:test');
const assert = require('node:assert/strict');
const { decideRole } = require('../src/services/accountClubs');
const { responsibilityRefusalMessage } = require('../src/services/clubRequestEmail');

function fakeDb() {
  const state = { logs: [], row: { id: 4, clubId: 2, userId: 9, status: 'PENDING', reason: 'Je gère le club' } };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    user: {
      findUnique: async ({ where }) =>
        where.id === 1 ? { isAdmin: true } : { clubId: 2, email: 'demandeur@example.fr' },
    },
    club: { findUnique: async () => ({ id: 2, name: 'CE Melun', leagueId: 3 }) },
    clubResponsibility: {
      findUnique: async () => state.row,
      upsert: async ({ update }) => (state.row = { ...state.row, ...update }),
    },
    auditLog: { create: async ({ data }) => state.logs.push(data) },
  };
  return { state, db: { ...tx, $transaction: async (fn) => fn(tx) } };
}

test('a refusal needs a motive, is recorded and emailed to the requester', async () => {
  const sent = [];
  const mail = { playerMailAvailable: () => true, sendMail: async (m) => sent.push(m) };
  const { db, state } = fakeDb();
  await assert.rejects(decideRole(db, 1, 9, 2, 'REJECTED', '  ', mail), /Motif du refus/);
  const out = await decideRole(db, 1, 9, 2, 'REJECTED', 'Un responsable est déjà nommé pour ce club.', mail);
  assert.equal(out.status, 'REJECTED');
  assert.equal(out.mailSent, true);
  assert.equal(sent[0].to, 'demandeur@example.fr');
  assert.match(sent[0].text, /Un responsable est déjà nommé/);
  assert.equal(state.logs.at(-1).after.motive, 'Un responsable est déjà nommé pour ce club.');
});

test('a failed email never cancels the refusal', async () => {
  const mail = {
    playerMailAvailable: () => true,
    sendMail: async () => {
      throw new Error('down');
    },
  };
  const { db } = fakeDb();
  const out = await decideRole(db, 1, 9, 2, 'REJECTED', 'Motif suffisamment long.', mail);
  assert.equal(out.status, 'REJECTED');
  assert.equal(out.mailSent, false);
});

test('the refusal email escapes the motive and the club name', () => {
  const m = responsibilityRefusalMessage({ id: 5, club: '<b>Club</b>\r\nBcc: x', motive: '<img src=x> & non' });
  assert.ok(!m.subject.includes('\n'));
  assert.ok(!m.html.includes('<img src=x>'));
  assert.match(m.html, /&lt;img src=x&gt; &amp; non/);
});
