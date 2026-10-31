const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refresh } = require('../src/services/ftlOfficialTime');
const root = 'https://www.fencingtimelive.com';
const id = 'A'.repeat(32),
  scheduleId = 'B'.repeat(32);
const config = {
  eventId: id,
  date: '2026-10-22',
  time: '1:00 PM',
  eventTime: 'Thursday, October 22, 2026 1:00 PM',
  timezone: 'Africa/Tunis',
  format: 'INDIVIDUAL',
  tournament: 'Synthetic Cup',
  event: "Cadet Women's Foil",
  name: 'Synthetic',
  sourceUrl: null,
  poolSources: ['unchanged-pools'],
  scheduleUrl: `${root}/tournaments/eventSchedule/${scheduleId}`,
  phaseDays: { T64: '2026-10-22' },
};
function setup({
  time = '1:30 PM',
  date = '2026-10-22',
  event = config.event,
  calendarTime = time,
  stored = config,
  fail = false,
} = {}) {
  const writes = [];
  const page = `<span class="desktop tournName">${config.tournament}</span><span class="desktop eventName">${event}</span><span class="desktop eventTime">${date} ${time}</span><a href="/events/competitors/${id}">Fencers</a><a href="/tournaments/eventSchedule/${scheduleId}">Schedule</a>`;
  const tx = {
    $queryRaw: async () => [],
    auditLog: {
      findFirst: async ({ where }) => (where.action === 'Configuration FTL validée' ? { after: stored } : null),
      create: async ({ data }) => writes.push(data),
    },
  };
  const db = { $transaction: async (fn) => fn(tx) };
  const client = {
    eventPage: async () => ({ url: `${root}/events/competitors/${id}`, html: page }),
    get: async () => {
      if (fail) throw Error('offline');
      return `<span class="desktop tournName">${config.tournament}</span><h5>Thursday, October 22, 2026</h5><table class="scheduleTable"><tbody><tr id="ev_${id}"><td>${calendarTime}</td><td><a href="/events/view/${id}">${event}</a></td></tr></tbody></table>`;
    },
  };
  return { db, client, writes };
}
test('report officiel du même jour : calendrier concordant, seuls les journaux changent', async () => {
  const d = setup();
  const before = structuredClone(config);
  const result = await refresh(d.db, { id: 42 }, config, 1, d.client, Date.parse('2026-10-22T11:00Z'));
  assert.equal(result.time, '1:30 PM');
  assert.equal(result.eventTime, '2026-10-22 1:30 PM');
  assert.equal(result.predictionStartAt, undefined);
  assert.deepEqual(result.poolSources, config.poolSources);
  assert.deepEqual(result.phaseDays, config.phaseDays);
  assert.equal(result.sourceUrl, null);
  assert.deepEqual(config, before);
  assert.equal(d.writes.length, 2);
  assert.equal(d.writes[0].action, 'Configuration FTL validée');
});
test('report après ancienne fermeture : garde la borne de fraîcheur, sans toucher aux points', async () => {
  const d = setup();
  const result = await refresh(d.db, { id: 42 }, config, 1, d.client, Date.parse('2026-10-22T12:10Z'));
  assert.equal(result.predictionStartAt, '2026-10-22T12:00:00.000Z');
  assert.equal(d.writes.length, 2);
});
test('avance horaire et alias préservés sans les enregistrer dans la configuration', async () => {
  const aliases = [{ from: 'Synthetic A', to: 'Synthetic B' }];
  const d = setup({ time: '12:30 PM' });
  const result = await refresh(
    d.db,
    { id: 42 },
    { ...config, nameAliases: aliases },
    1,
    d.client,
    Date.parse('2026-10-22T11:00Z'),
  );
  assert.equal(result.time, '12:30 PM');
  assert.deepEqual(result.nameAliases, aliases);
  assert.equal(d.writes[0].after.nameAliases, undefined);
});
for (const [label, options] of [
  ['autre date', { date: '2026-10-23' }],
  ['autre identité', { event: "Cadet Men's Foil" }],
  ['calendrier différent', { calendarTime: '2:00 PM' }],
  ['réseau coupé', { fail: true }],
  ['configuration concurrente', { stored: { ...config, time: '9:00 AM' } }],
])
  test(`${label} : refus sans écriture`, async () => {
    const d = setup(options);
    await assert.rejects(refresh(d.db, { id: 42 }, config, 1, d.client));
    assert.equal(d.writes.length, 0);
  });
test('même heure déjà validée : aucune écriture et aucun accès calendrier', async () => {
  const c = { ...config, eventTime: '2026-10-22 1:00 PM' };
  const d = setup({ time: '1:00 PM' });
  d.client.get = () => assert.fail('lecture inutile');
  assert.equal(await refresh(d.db, { id: 42 }, c, 1, d.client), c);
  assert.equal(d.writes.length, 0);
});
test('borne de fraîcheur après report : le serveur ne rend pas une saisie à nouveau disponible', async () => {
  const { eventStartFor } = require('../src/services/eventStart');
  const c = {
    ...config,
    eventTime: '2026-10-22 1:30 PM',
    time: '1:30 PM',
    predictionStartAt: '2026-10-22T12:00:00.000Z',
  };
  const db = {
    competition: { findUnique: async () => ({ id: 42 }) },
    auditLog: {
      findFirst: async ({ where }) => (where.action === 'Configuration FTL validée' ? { id: 1, after: c } : null),
    },
  };
  assert.equal(await eventStartFor(db, 42), Date.parse('2026-10-22T12:00:00.000Z'));
  const pool = { lockMode: 'FIRST_RESULT', sourceCheckedAt: new Date('2026-10-22T11:50Z') };
  const now = new Date('2026-10-22T12:10Z');
  assert.equal(require('../src/services/poolRules').sourceUnavailable(pool, now, await eventStartFor(db, 42)), true);
});

test('liaison de compétition différente : refus avant toute lecture ou écriture', async () => {
  const d = setup();
  d.client.eventPage = () => assert.fail('source différente');
  await assert.rejects(refresh(d.db, { id: 42, ftlEventId: 'C'.repeat(32) }, config, 1, d.client), /ne correspond pas/);
  assert.equal(d.writes.length, 0);
});
test('ancienne configuration sans calendrier : découvre seulement le lien observé dans la page', async () => {
  const { scheduleUrl, ...c } = config;
  const d = setup({ stored: c });
  const result = await refresh(d.db, { id: 42 }, c, 1, d.client, Date.parse('2026-10-22T11:00Z'));
  assert.equal(result.scheduleUrl, scheduleUrl);
  assert.equal(result.time, '1:30 PM');
});
test('reprise après erreur réseau puis répétition : actualisation une seule fois', async () => {
  const d = setup({ fail: true });
  await assert.rejects(refresh(d.db, { id: 42 }, config, 1, d.client));
  assert.equal(d.writes.length, 0);
  const online = setup();
  const next = await refresh(online.db, { id: 42 }, config, 1, online.client);
  assert.equal(online.writes.length, 2);
  assert.equal(await refresh(online.db, { id: 42 }, next, 1, online.client), next);
  assert.equal(online.writes.length, 2);
});

test('multijours : accepte l’heure corrigée mais conserve les jours et le tableau', async () => {
  const sessions = [
    { date: '2026-10-22', time: '1:00 PM', event: `${config.event} (Day 1)` },
    { date: '2026-10-23', time: '9:00 AM', event: `${config.event} (Day 2)` },
  ];
  const c = { ...config, scheduleSessions: sessions, sourceUrl: 'same-tableau' };
  const d = setup({ stored: c });
  d.client.get = async () =>
    `<span class="desktop tournName">${config.tournament}</span>` +
    sessions
      .map(
        (s, i) =>
          `<h5>${s.date}</h5><table class="scheduleTable"><tbody><tr id="ev_${id}"><td>${i ? '9:00 AM' : '1:30 PM'}</td><td><a href="/events/view/${id}">${s.event}</a></td></tr></tbody></table>`,
      )
      .join('');
  const next = await refresh(d.db, { id: 42 }, c, 1, d.client, Date.parse('2026-10-22T11:00Z'));
  assert.deepEqual(
    next.scheduleSessions.map((s) => s.date),
    sessions.map((s) => s.date),
  );
  assert.equal(next.scheduleSessions[0].time, '1:30 PM');
  assert.equal(next.sourceUrl, 'same-tableau');
});
test('multijours : disparition d’une session refusée sans écriture', async () => {
  const c = { ...config, scheduleSessions: [{ date: '2026-10-22' }, { date: '2026-10-23' }] };
  const d = setup({ stored: c });
  await assert.rejects(refresh(d.db, { id: 42 }, c, 1, d.client));
  assert.equal(d.writes.length, 0);
});

function renamed({ event = config.event, date = 'Thursday, October 22, 2026', scheduleLink = true, stored = config } = {}) {
  const writes = [],
    renames = [];
  const html = `<span class="desktop tournName">Synthetic Cup 2026</span><span class="desktop eventName">${event}</span><span class="desktop eventTime">${date} 1:00 PM</span><a href="/events/competitors/${id}">Fencers</a>${scheduleLink ? `<a href="/tournaments/eventSchedule/${scheduleId}">Schedule</a>` : ''}`;
  const tx = {
    $queryRaw: async () => [],
    auditLog: {
      findFirst: async ({ where }) => (where.action === 'Configuration FTL validée' ? { after: stored } : null),
      create: async ({ data }) => writes.push(data),
    },
    tournament: { updateMany: async (query) => renames.push(query) },
  };
  return {
    writes,
    renames,
    db: { $transaction: async (fn) => fn(tx) },
    client: { eventPage: async () => ({ url: `${root}/events/competitors/${id}`, html }) },
  };
}
const competition = { id: 9, tournamentId: 14 };
test('tournoi renommé sur la source : même épreuve et même calendrier, le nouveau nom est suivi', async () => {
  const d = renamed();
  const next = await refresh(d.db, competition, config, 0, d.client);
  assert.equal(next.tournament, 'Synthetic Cup 2026');
  assert.equal(next.poolSources[0], 'unchanged-pools');
  assert.equal(d.writes[0].after.tournament, 'Synthetic Cup 2026');
  assert.equal(d.writes[1].action, 'Nom officiel du tournoi actualisé');
  assert.deepEqual(d.renames, [
    { where: { id: 14, name: 'Synthetic Cup' }, data: { name: 'Synthetic Cup 2026' } },
  ]);
});
test('tournoi renommé : autre épreuve, autre jour ou calendrier absent restent refusés', async () => {
  for (const options of [
    { event: "Senior Women's Foil" },
    { date: 'Friday, October 23, 2026' },
    { scheduleLink: false },
  ]) {
    const d = renamed(options);
    await assert.rejects(refresh(d.db, competition, config, 0, d.client), /Identité ou date officielle/);
    assert.equal(d.writes.length, 0);
    assert.equal(d.renames.length, 0);
  }
});
