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

const engardeXml = (extra = false, org = 'heninbeaumont') =>
  `<?xml version="1.0"?><comps>${[['fhs_samedi', 'm', '17'], ['fd_samedi', 'f', '17'], ...(extra ? [['h_national', 'm', '18']] : [])].map(([compe, sexe, day]) => `<comp org="${org}" evt="seniorf1026" compe="${compe}" sexe="${sexe}" arme="f" estindividuelle="1" date="2026 10 ${day}" startTime="10:00:00" pays="FRA"><categorie>senior</categorie><titre>TEST</titre></comp>`).join('')}</comps>`;
const et = {
  id: 8,
  name: 'TEST',
  ftlSourceUrl: 'https://engarde-service.com/tournament/heninbeaumont/seniorf1026',
  competitions: [{ id: 23, ftlEventId: 'ENGARDE:heninbeaumont/seniorf1026/fhs_samedi' }],
};
test('Engarde : source publique, IDs liés reconnus, reprise ancienne erreur, pas de connexion FTL ni import', async () => {
  const { db, rows } = database();
  const eid = 'heninbeaumont/seniorf1026/fhs_samedi';
  db.auditLog.findFirst = async (q) => {
    assert.equal(q.where.targetType, 'EngardePreview');
    return { after: { events: [{ eventId: eid }] } };
  };
  rows.set(D.PREFIX + 8, { value: { events: {}, lastError: 'ancienne erreur' } });
  let alerts = 0;
  const notify = async (d, alert) => {
    alerts++;
    assert.match(alert.title, /Engarde/);
    return { mail: 0 };
  };
  const client = {
    login: () => assert.fail('aucun login FTL'),
    get: () => assert.fail('aucune page FTL'),
    engarde: { competitions: async () => engardeXml() },
  };
  await D.scan(db, et, cfg, client, now, notify);
  let state = rows.get(D.PREFIX + 8).value;
  assert.equal(state.lastError, null);
  assert.equal(state.events[eid].status, 'ADDED');
  const girls = 'heninbeaumont/seniorf1026/fd_samedi';
  assert.equal(state.events[girls].status, 'PENDING');
  assert.equal(alerts, 1);
  await D.dismiss(db, 8, girls, 1);
  await D.scan(db, et, cfg, client, new Date(+now + 3600000), notify);
  assert.equal(rows.get(D.PREFIX + 8).value.events[girls].status, 'DISMISSED');
  assert.equal(alerts, 1);
  await D.scan(
    db,
    et,
    cfg,
    { engarde: { competitions: async () => engardeXml(false, 'other') } },
    new Date(+now + 7200000),
    notify,
  );
  state = rows.get(D.PREFIX + 8).value;
  assert.ok(state.lastError);
  assert.equal(state.leaseUntil, null);
  assert.equal(state.events[eid].status, 'ADDED');
  assert.equal(alerts, 1);
});
test('Engarde : dimanche Hénin rattaché à samedi, aucune nouvelle compétition proposée', async () => {
  const { db, rows } = database();
  db.auditLog.findFirst = async () => null;
  const client = { engarde: { competitions: async () => engardeXml() } };
  await D.scan(db, et, cfg, client, now, () => assert.fail('aucune alerte initiale'));
  client.engarde.competitions = async () => engardeXml(true);
  await D.scan(db, et, cfg, client, new Date(+now + 3600000), () => assert.fail('dimanche ne crée pas de doublon'));
  assert.equal(Object.keys(rows.get(D.PREFIX + 8).value.events).length, 2);
});
test('identités FTL et Engarde valides seulement, y compris routes encodées par le client', () => {
  assert.equal(D.eventIdentity(A.toLowerCase()), A);
  assert.equal(D.eventIdentity('ENGARDE:HENINBEAUMONT/SENIORF1026/FD_SAMEDI'), 'heninbeaumont/seniorf1026/fd_samedi');
  for (const id of ['a/b/c?x=1', 'a/b/c#x', 'a/../c', 'a/b/c/d', '', 'https://evil/a'])
    assert.throws(() => D.eventIdentity(id), { status: 400 });
});

test('ancienne erreur Engarde hors fenêtre sportive : relire réellement puis arrêter les contrôles hors fenêtre', async () => {
  const { db, rows } = database();
  const error = 'Utilisez le lien SCHEDULE du tournoi FencingTimeLive, ou le lien du tournoi engarde-service.';
  rows.set(D.PREFIX + 8, { value: { events: {}, lastError: error } });
  db.tournament = { findMany: async () => [structuredClone(et)] };
  db.auditLog.findFirst = async ({ where }) =>
    where.action === 'Configuration FTL validée' ? { after: { timezone: 'Europe/Paris', date: '2026-11-07' } } : null;
  let reads = 0;
  const client = {
    engarde: {
      competitions: async () => {
        reads++;
        return engardeXml();
      },
    },
  };
  await D.watch(db, { now, force: true, client, notify: () => assert.fail('pas de nouvelle épreuve') });
  assert.equal(reads, 1);
  assert.equal(rows.get(D.PREFIX + 8).value.lastError, null);
  await D.watch(db, { now: new Date(+now + 3600000), force: true, client });
  assert.equal(reads, 1);
});
test('liste administrative : une épreuve Engarde déjà liée ne reste pas proposée', async () => {
  const { db, rows } = database();
  const eid = 'heninbeaumont/seniorf1026/fhs_samedi';
  rows.set(D.PREFIX + 8, { key: D.PREFIX + 8, value: { events: { [eid]: { eventId: eid, status: 'PENDING' } } } });
  db.appSetting.findMany = async () => [...rows.values()];
  db.competition = { findMany: async () => et.competitions };
  db.tournament = { findMany: async () => [et] };
  assert.deepEqual((await D.list(db))[0].events, []);
});
