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
  assert.equal(await refreshSessions(db, { id: 21 }, config, 1, { get: async () => html(false) }), config);
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
