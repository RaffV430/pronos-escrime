const { test } = require('node:test');
const assert = require('node:assert/strict');
const { content, prepare, dispatch } = require('../src/services/generalAnnouncements');
function database(subs = []) {
  const rows = new Map(),
    audit = [];
  let tail = Promise.resolve();
  const db = {
    appSetting: {
      create: async ({ data }) => rows.set(data.key, structuredClone(data)),
      findUnique: async ({ where }) => structuredClone(rows.get(where.key)),
      update: async ({ where, data }) => rows.set(where.key, { key: where.key, value: structuredClone(data.value) }),
    },
    auditLog: { create: async ({ data }) => audit.push(data) },
    pushSubscription: {
      findMany: async () => subs.filter((s) => s.enabled).map(({ id, userId }) => ({ id, userId })),
      findUnique: async ({ where }) => subs.find((s) => s.id === where.id),
      update: async ({ where, data }) =>
        Object.assign(
          subs.find((s) => s.id === where.id),
          data,
        ),
    },
    $queryRaw: async () => [],
    $transaction: (fn) => {
      const next = tail.then(() => fn(db));
      tail = next.catch(() => {});
      return next;
    },
  };
  return { db, rows, audit };
}
const msg = { title: 'Épreuve', body: 'Poules ouvertes', url: '/pronostiquer/t-7/e-20/poules' };
test('refuse liens externes et messages vides ou trop longs', () => {
  for (const url of ['https://evil.test', '//evil.test', '/\\evil', '/ a', '/x\ny'])
    assert.throws(() => content({ ...msg, url }));
  assert.throws(() => content({ ...msg, title: '' }));
  assert.throws(() => content({ ...msg, body: 'a'.repeat(241) }));
  assert.deepEqual(content(msg), msg);
});
test('préparation ne transmet rien, reprise et appels concurrents ne doublent pas un envoi', async () => {
  const subs = Array.from({ length: 7 }, (_, i) => ({ id: String(i), userId: i % 2, enabled: true }));
  const { db, audit } = database(subs),
    sent = [];
  const p = await prepare(db, 1, msg);
  assert.equal(p.users, 2);
  assert.equal(p.total, 7);
  assert.equal(p.sent, 0);
  const sender = async (s, c) => {
    sent.push(s.id);
    assert.equal(c.url, msg.url);
  };
  await Promise.all([dispatch(db, 1, p.id, sender), dispatch(db, 1, p.id, sender)]);
  let out = await dispatch(db, 1, p.id, sender);
  assert.equal(out.sent, 7);
  assert.equal(new Set(sent).size, 7);
  await dispatch(db, 1, p.id, sender);
  assert.equal(sent.length, 7);
  assert.equal(audit.filter((a) => a.action === 'ANNONCE_CONFIRMEE').length, 1);
});
test('désabonnement et heures silencieuses ignorés, abonnement expiré désactivé, refus non réessayé', async () => {
  const subs = [
    { id: 'a', userId: 1, enabled: true },
    { id: 'b', userId: 2, enabled: true },
    {
      id: 'c',
      userId: 3,
      enabled: true,
      preferences: {
        quietEnabled: true,
        quietStart: new Date(Date.now() - 60000).toISOString().slice(11, 16),
        quietEnd: new Date(Date.now() + 60000).toISOString().slice(11, 16),
        timezone: 'UTC',
      },
    },
  ];
  const { db } = database(subs);
  const p = await prepare(db, 1, msg);
  subs[0].enabled = false;
  const sent = [];
  const sender = async (s) => {
    sent.push(s.id);
    throw { statusCode: 410 };
  };
  const out = await dispatch(db, 1, p.id, sender);
  assert.deepEqual(sent, ['b']);
  assert.equal(out.skipped, 2);
  assert.equal(out.failed, 1);
  assert.equal(subs[1].enabled, false);
  await dispatch(db, 1, p.id, sender);
  assert.equal(sent.length, 1);
});
test('un traitement interrompu reste incertain et ne peut pas être renvoyé', async () => {
  const { db, rows } = database([{ id: 'a', userId: 1, enabled: true }]);
  const p = await prepare(db, 1, msg);
  rows.get('announcement:' + p.id).value.targets[0].state = 'SENDING';
  const out = await dispatch(db, 1, p.id, () => {
    throw new Error('ne doit pas envoyer');
  });
  assert.equal(out.uncertain, 1);
  assert.equal(out.pending, 0);
});

test('une annonce expirée ou inconnue ne transmet rien', async () => {
  const { db, rows } = database([{ id: 'a', userId: 1, enabled: true }]);
  const p = await prepare(db, 1, msg);
  rows.get('announcement:' + p.id).value.createdAt = new Date(Date.now() - 86400001).toISOString();
  const sender = () => {
    throw new Error('aucun envoi attendu');
  };
  await assert.rejects(dispatch(db, 1, p.id, sender), { status: 409 });
  await assert.rejects(dispatch(db, 1, '00000000-0000-0000-0000-000000000000', sender), { status: 404 });
});
