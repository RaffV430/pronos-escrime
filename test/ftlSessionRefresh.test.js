const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refreshSessions } = require('../src/services/ftlTournament');
const id = 'F4117EF977EB42C9AA3131378C81ADA4';
const config = {
  eventId: id,
  event: "Senior Women's Foil",
  name: "Senior Women's Foil",
  date: '2026-10-16',
  time: '9:00 AM',
  format: 'INDIVIDUAL',
  timezone: 'Asia/Tokyo',
  tournament: 'TEST World Cup',
  scheduleUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${'A'.repeat(32)}`,
  sourceUrl: `https://www.fencingtimelive.com/tableaus/scores/${id}/${'B'.repeat(32)}`,
  poolSources: ['existing-pools'],
};
const session = (day, date, name = config.event) =>
  `<h5>${date}</h5><table class="scheduleTable"><tbody><tr id="ev_${id}"><td>9:00 AM</td><td><a href="/events/view/${id}">${name} (Day ${day})</a></td></tr></tbody></table>`;
const html = (second = true, name = config.event) =>
  '<div class="desktop tournName">TEST World Cup</div>' +
  session(1, 'Friday October 16, 2026', name) +
  (second ? session(2, 'Sunday October 18, 2026', name) : '');
function fake(stored = config) {
  const writes = [];
  const untouched = { predictions: [{ id: 7, fencerId: 3, pointsEarned: 4 }], matchIds: [8] };
  const tx = {
    $queryRaw: async () => [],
    auditLog: {
      findFirst: async ({ where }) => (where.action === 'Configuration FTL validée' ? { after: stored } : null),
      create: async ({ data }) => writes.push(data),
    },
  };
  return { writes, untouched, $transaction: async (fn) => fn(tx) };
}
test('ancienne configuration dames : récupère les deux sessions sans remplacer les sources ni les pronostics', async () => {
  const db = fake();
  const before = structuredClone(db.untouched);
  const aliases = [{ from: 'TEST A', to: 'TEST B' }];
  const next = await refreshSessions(db, { id: 21 }, { ...config, nameAliases: aliases }, 1, {
    get: async (url) => {
      assert.equal(url, config.scheduleUrl);
      return html();
    },
  });
  assert.deepEqual(
    next.scheduleSessions.map((s) => s.date),
    ['2026-10-16', '2026-10-18'],
  );
  assert.equal(next.sourceUrl, config.sourceUrl);
  assert.deepEqual(next.poolSources, config.poolSources);
  assert.deepEqual(next.nameAliases, aliases);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].after.nameAliases, undefined);
  assert.deepEqual(db.untouched, before);
  const again = await refreshSessions(db, { id: 21 }, next, 1, { get: () => assert.fail('déjà configuré') });
  assert.equal(again, next);
  assert.equal(db.writes.length, 1);
});
test('un seul jour ne donne aucune permission de préliminaire', async () => {
  const db = fake();
  assert.equal(
    await refreshSessions(db, { id: 21 }, config, 1, {
      get: async (url) =>
        url === config.scheduleUrl
          ? html(false).replace(' (Day 1)', '')
          : format('Complete tableau of 128 fenced through the finals.'),
    }),
    config,
  );
  assert.equal(db.writes.length, 0);
});
test('autre épreuve ou modification concurrente : aucune écriture', async () => {
  const wrong = fake();
  await assert.rejects(
    refreshSessions(wrong, { id: 21 }, config, 1, { get: async () => html(true, "Senior Men's Foil") }),
    /non concordantes/,
  );
  assert.equal(wrong.writes.length, 0);
  const changed = fake({ ...config, sourceUrl: 'changed' });
  await assert.rejects(
    refreshSessions(changed, { id: 21 }, config, 1, { get: async () => html() }),
    /Configuration modifiée/,
  );
  assert.equal(changed.writes.length, 0);
});

const format = (text, event = config.event) =>
  `<span class="desktop tournName">${config.tournament}</span><span class="desktop eventName">${event}</span><span class="desktop eventTime"></span><div id="mainContent">${text}</div>`;
const formula =
  'Incomplete tableau of 128 fenced until 32 competitors remain. Complete tableau of 64 fenced through the finals.';
test('formule officielle dames : préliminaire reconnu sans inventer une deuxième date', async () => {
  const d = fake();
  const next = await refreshSessions(d, { id: 21 }, config, 1, {
    get: async (url) => (url === config.scheduleUrl ? html(false).replace(' (Day 1)', '') : format(formula)),
  });
  assert.equal(next.preliminaryUntil, 'T64');
  assert.equal(next.scheduleSessions, undefined);
  assert.equal(next.formatSourceUrl, `https://www.fencingtimelive.com/events/format/${id}`);
  assert.equal(require('../src/services/ftlTableauPhases').enabled(next), true);
  assert.deepEqual(next.poolSources, config.poolSources);
  assert.equal(next.sourceUrl, config.sourceUrl);
  assert.equal(d.writes.length, 1);
  await refreshSessions(d, { id: 21 }, next, 1, { get: () => assert.fail('preuve déjà enregistrée') });
});
test('formule incomplète ou autre identité : pas de mode préliminaire', async () => {
  const d = fake();
  const get = (text) => async (url) => (url === config.scheduleUrl ? html(false).replace(' (Day 1)', '') : text);
  assert.equal(
    await refreshSessions(d, { id: 21 }, config, 1, {
      get: get(format('Incomplete tableau of 128 fenced until 16 competitors remain.')),
    }),
    config,
  );
  await assert.rejects(
    refreshSessions(d, { id: 21 }, config, 1, { get: get(format(formula, "Senior Men's Foil")) }),
    /Identité/,
  );
  assert.equal(d.writes.length, 0);
});
test('tableau dames réel anonymisé : lecture J1:T128 et J1:T64 avec seule preuve de formule', async () => {
  const fs = require('node:fs'),
    { load } = require('cheerio');
  const table = fs.readFileSync(`${__dirname}/fixtures/ftl-women-preliminary-anonymous.html`, 'utf8');
  const $ = load(table);
  const roster = [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .trim(),
        )
        .filter((n) => n && !n.includes('BYE')),
    ),
  ].map((name, i) => ({ name, id: String(i + 1) }));
  const guid = 'C'.repeat(32);
  const page = format('');
  const client = {
    get: async (url) =>
      url.endsWith('/trees')
        ? [{ treeNum: 0, guid, numTables: 1, name: 'Primary Tableau' }]
        : url.includes('/tables/')
          ? table
          : page,
  };
  const { observe } = require('../src/services/ftlSync');
  const c = {
    name: config.name,
    rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${id}`,
    podiumRoster: roster,
    podiumFormat: 'INDIVIDUAL',
  };
  await assert.rejects(observe(c, [], client, config, true), /derniers tours/);
  const out = await observe(c, [], client, { ...config, preliminaryUntil: 'T64' }, true);
  assert.deepEqual(
    out.rounds.map((r) => r.round),
    ['J1:T128', 'J1:T64'],
  );
  assert.equal(out.rounds.find((r) => r.round === 'J1:T64').expectedMatchCount, 32);
  assert.equal(out.matches.filter((m) => m.round === 'J1:T64').length, 18);
  assert.ok(out.matches.every((m) => m.sourceKey.startsWith('J1:')));
  assert.equal(out.officialPodium, null);
});
test('principal publié sans date J2 : ne réutilise pas la date J1 pour fermer les pronostics', async () => {
  const fs = require('node:fs'),
    { load } = require('cheerio');
  const table = fs.readFileSync(`${__dirname}/fixtures/ftl-team.html`, 'utf8');
  const $ = load(table);
  const roster = [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .trim(),
        )
        .filter((n) => n && !n.includes('BYE')),
    ),
  ].map((name, i) => ({ name, id: String(i + 1) }));
  const client = {
    get: async (url) =>
      url.endsWith('/trees')
        ? [{ treeNum: 0, guid: 'C'.repeat(32), numTables: 1, name: 'Primary Tableau' }]
        : url.includes('/tables/')
          ? table
          : format(''),
  };
  const c = {
    name: config.name,
    podiumFormat: 'INDIVIDUAL',
    podiumRoster: roster,
    rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${id}`,
  };
  const out = await require('../src/services/ftlSync').observe(
    c,
    [],
    client,
    { ...config, preliminaryUntil: 'T64' },
    true,
  );
  assert.ok(out.rounds.some((r) => r.round === 'T2'));
  assert.ok(out.matches.length > 0);
  assert.ok(out.matches.every((m) => m.startsAt === null));
});

test('les horaires J2 peuvent enrichir une formule split déjà connue', async () => {
  const original = { ...config, preliminaryUntil: 'T64' };
  const d = fake(original);
  const next = await refreshSessions(d, { id: 21 }, original, 1, { get: async () => html() }, { sessionsOnly: true });
  assert.equal(next.scheduleSessions.length, 2);
});
