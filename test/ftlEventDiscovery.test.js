const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/services/ftlEventDiscovery');
const A = 'A'.repeat(32),
  B = 'B'.repeat(32),
  source = `https://www.fencingtimelive.com/tournaments/eventSchedule/${A}`;
const row = (id, name) => `<tr id="ev_${id}"><td>9:00 AM</td><td><a href="/events/view/${id}">${name}</a></td></tr>`;
const html = () =>
  `<div class="desktop tournName">Test Cup</div><h5>Thursday October 15, 2026</h5><table class="scheduleTable"><tbody>${row(A, "Senior Men's Foil")}${row(B, "Senior Women's Foil")}</tbody></table>`;
const now = new Date('2026-10-14T12:00:00Z'),
  t = { id: 7, name: 'Test Cup', ftlSourceUrl: source, competitions: [{ id: 20, ftlEventId: A }] },
  cfg = { timezone: 'Asia/Tokyo' };
function database() {
  const rows = new Map();
  let tail = Promise.resolve();
  const db = {
    $queryRaw: async () => [],
    appSetting: {
      findUnique: async ({ where }) => structuredClone(rows.get(where.key)),
      upsert: async ({ where, create, update }) =>
        rows.set(where.key, structuredClone(rows.has(where.key) ? { key: where.key, ...update } : create)),
    },
    auditLog: { create: async () => {}, findFirst: async () => ({ after: { events: [{ eventId: A }] } }) },
    $transaction: (fn) => {
      const p = tail.then(() => fn(db));
      tail = p.catch(() => {});
      return p;
    },
  };
  return { db, rows };
}
test('une heure entre contrôles, épreuve dames signalée une fois sans créer ni modifier de compétition', async () => {
  const { db, rows } = database();
  let reads = 0,
    alerts = 0;
  const client = {
    login: async () => {},
    get: async () => {
      reads++;
      return html();
    },
  };
  const notify = async () => {
    alerts++;
    return { mail: 1, push: 1 };
  };
  await D.scan(db, t, cfg, client, now, notify);
  await D.scan(db, t, cfg, client, new Date(now.getTime() + 3599999), notify);
  assert.equal(reads, 1);
  assert.equal(alerts, 1);
  assert.equal(D.INTERVAL, 3600000);
  await D.scan(db, t, cfg, client, new Date(now.getTime() + 3600000), notify);
  assert.equal(reads, 2);
  assert.equal(alerts, 1);
  const state = rows.get(D.PREFIX + 7).value;
  assert.equal(state.events[A].status, 'ADDED');
  assert.equal(state.events[B].status, 'PENDING');
});
test('contrôle manuel contourne le délai mais garde la cadence et refuse un contrôle parallèle', async () => {
  const { db, rows } = database();
  const client = { login: async () => {}, get: async () => html() };
  await D.scan(db, t, cfg, client, now, async () => ({}));
  const next = rows.get(D.PREFIX + 7).value.nextCheckAt;
  await D.scan(db, t, cfg, client, new Date(now.getTime() + 1000), async () => ({}), true);
  assert.equal(rows.get(D.PREFIX + 7).value.nextCheckAt, next);
  rows.get(D.PREFIX + 7).value.leaseUntil = new Date(now.getTime() + 90000).toISOString();
  await assert.rejects(
    D.scan(db, t, cfg, client, now, async () => ({}), true),
    { status: 409 },
  );
});
test('source illisible : garder les alertes et ne jamais en inventer', async () => {
  const { db, rows } = database();
  let alerts = 0;
  await D.scan(db, t, cfg, { login: async () => {}, get: async () => html() }, now, async () => {
    alerts++;
    return {};
  });
  await D.scan(
    db,
    t,
    cfg,
    { login: async () => {}, get: async () => '<html>indisponible</html>' },
    new Date(now.getTime() + 3600000),
    async () => {
      alerts++;
    },
  );
  assert.equal(alerts, 1);
  const state = rows.get(D.PREFIX + 7).value;
  assert.equal(state.events[B].status, 'PENDING');
  assert.ok(state.lastError);
  assert.equal(state.leaseUntil, null);
});
test('ignorer, disparition, réapparition et ajout explicite ne recréent pas une alerte', () => {
  const state = { events: {} };
  const events = [{ eventId: B, event: 'Women', date: '2026-10-15' }];
  assert.deepEqual(D.reconcile(state, events, new Set(), now), [B]);
  state.events[B].status = 'DISMISSED';
  D.reconcile(state, [], new Set(), now);
  assert.equal(state.events[B].present, false);
  assert.deepEqual(D.reconcile(state, events, new Set(), now), []);
  assert.equal(state.events[B].status, 'DISMISSED');
  D.reconcile(state, events, new Set([B]), now);
  assert.equal(state.events[B].status, 'ADDED');
});
test('échec des canaux : l’alerte reste visible et le contrôle suivant ne spamme pas', async () => {
  const { db, rows } = database();
  let calls = 0;
  const client = { login: async () => {}, get: async () => html() };
  const notify = async () => {
    calls++;
    throw Error('offline');
  };
  await D.scan(db, t, cfg, client, now, notify);
  await D.scan(db, t, cfg, client, new Date(now.getTime() + 3600000), notify);
  assert.equal(calls, 1);
  assert.equal(rows.get(D.PREFIX + 7).value.events[B].delivery.uncertain, true);
});

test('l’épreuve est signalée même si FTL ne publie pas encore son horaire, sans inventer d’heure', async () => {
  const { db, rows } = database();
  let alerts = 0;
  await D.scan(
    db,
    t,
    cfg,
    { login: async () => {}, get: async () => html().replaceAll('9:00 AM', 'TBD') },
    now,
    async () => {
      alerts++;
      return {};
    },
  );
  assert.equal(alerts, 1);
  assert.equal(rows.get(D.PREFIX + 7).value.events[B].time, null);
});

test('sans aperçu historique, premier passage établit une référence sans notifier les anciennes épreuves', async () => {
  const { db, rows } = database();
  db.auditLog.findFirst = async () => null;
  let alerts = 0;
  await D.scan(db, t, cfg, { login: async () => {}, get: async () => html() }, now, async () => {
    alerts++;
  });
  assert.equal(alerts, 0);
  assert.equal(rows.get(D.PREFIX + 7).value.events[B].status, 'KNOWN');
});
