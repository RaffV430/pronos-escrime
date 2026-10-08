const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterIsSubset } = require('../src/services/ftlTournament');

test('official withdrawal accepts the remaining identities without mutating the frozen roster', () => {
  const current = [
    { id: 'a', name: 'MARTIN Alice' },
    { id: 'b', name: 'DURAND Bob' },
  ];
  const before = JSON.stringify(current);
  assert.equal(rosterIsSubset(current, [current[0]]), true);
  assert.equal(rosterIsSubset(current, [...current].reverse()), true);
  assert.equal(JSON.stringify(current), before);
});

test('withdrawal tolerance rejects additions, changed identities, empty and duplicate rosters', () => {
  const current = [{ id: 'a', name: 'MARTIN Alice' }];
  for (const observed of [
    null,
    [],
    [{ id: 'b', name: 'MARTIN Alice' }],
    [{ id: 'a', name: 'DURAND Bob' }],
    [current[0], current[0]],
    [...current, { id: 'b', name: 'DURAND Bob' }],
  ]) {
    assert.equal(rosterIsSubset(current, observed), false);
  }
});

test('pending refresh keeps the full frozen roster after a withdrawal and rejects an added entrant', async () => {
  const eventId = 'A'.repeat(32);
  const base = 'https://www.fencingtimelive.com';
  const rosterUrl = `${base}/events/competitors/${eventId}`;
  const config = {
    name: 'Cadets',
    event: "Cadet Men's Foil",
    tournament: 'Étampes',
    date: '2026-10-10',
    time: '8:30 AM',
    eventId,
    format: 'INDIVIDUAL',
    eventSourceUrl: `${base}/events/view/${eventId}`,
    scheduleUrl: `${base}/tournaments/eventSchedule/${'B'.repeat(32)}`,
  };
  const frozen = [
    { id: '1'.repeat(32), name: 'MARTIN Alice', country: 'FRA' },
    { id: '2'.repeat(32), name: 'DURAND Bob', country: 'FRA' },
  ];
  const c = {
    id: 14,
    name: 'Cadets',
    podiumFormat: 'INDIVIDUAL',
    ftlEventId: eventId,
    podiumRoster: frozen,
    rosterSourceUrl: rosterUrl,
  };
  let observed = [frozen[0]],
    updates = [],
    audits = [];
  const html = `<div class="desktop tournName">Étampes</div><div class="desktop eventName">Cadet Men's Foil</div><div class="desktop eventTime">Saturday, October 10, 2026 8:30 AM</div><a href="${config.scheduleUrl}">Schedule</a><a href="${rosterUrl}">Competitors</a><div id="compList" data-url="/events/competitors/data/${eventId}"></div>`;
  const client = {
    eventPage: async () => ({ html, url: rosterUrl }),
    get: async (url) => (url === rosterUrl ? html : observed),
  };
  const db = {
    $queryRaw: async () => [],
    competition: {
      findUnique: async () => c,
      update: async ({ data }) => {
        updates.push(data);
        return c;
      },
    },
    match: { findMany: async () => [] },
    auditLog: { findFirst: async () => null, create: async (row) => audits.push(row) },
  };
  db.$transaction = async (fn) => fn(db);
  const { refreshPending } = require('../src/services/ftlTournament');
  await refreshPending(db, c, config, 1, client);
  assert.equal(updates.length, 1);
  assert.equal('podiumRoster' in updates[0], false);
  assert.deepEqual(c.podiumRoster, frozen);
  assert.equal(audits.length, 1);
  observed = [...observed, { id: '3'.repeat(32), name: 'NOUVEAU Charles', country: 'FRA' }];
  await assert.rejects(refreshPending(db, c, config, 1, client), /engagés existants diffèrent/);
  assert.equal(updates.length, 1, 'no write on identity conflict');
});
