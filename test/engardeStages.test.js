const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/services/engardeStages');
const C = require('../src/services/calendarWatch');
const event = (extra = {}) => ({
  org: 'heninbeaumont',
  tournamentSlug: 'seniorf1026',
  compe: 'fh_samedi',
  event: 'Fleuret Hommes senior',
  date: '2026-10-17',
  time: '10:00',
  format: 'INDIVIDUAL',
  eventSourceUrl: 'https://engarde-service.com/competition/heninbeaumont/seniorf1026/fh_samedi',
  ...extra,
});
test('qualification garçons trois tours, filles deux, puis un tour national ; aucune URL dimanche devinée', () => {
  const h = event(),
    d = event({ event: 'Fleuret Dames senior', compe: 'fd_samedi' });
  assert.equal(S.profile(h).rounds, 3);
  assert.equal(S.profile(d).rounds, 2);
  assert.equal(S.sessions(h, [h, d]).length, 1);
  assert.equal(S.sessions(h, [{ ...h, compe: 'fhs_samedi' }, d])[0].compe, 'fhs_samedi');
  const sunday = event({
    date: '2026-10-18',
    time: '08:00',
    compe: 'national-h',
    eventSourceUrl: 'https://engarde-service.com/competition/heninbeaumont/seniorf1026/national-h',
  });
  const sessions = S.sessions(h, [h, d, sunday]);
  assert.equal(sessions[1].roundOffset, 3);
  assert.equal(sessions[1].eventSourceUrl, sunday.eventSourceUrl);
  assert.deepEqual(S.canonicalEvents([h, d, sunday]), [h, d]);
  assert.throws(() => S.sessions(h, [h, sunday, { ...sunday, compe: 'other' }]), /ambigu/);
  assert.equal(S.profile(event({ tournamentSlug: 'other' })), null);
});
test('Hénin : source officielle reconnue même hors de la première page des tournois', () => {
  const e = C.events().find((e) => e.id === '2026-10-17-henin-beaumont-senior-ind');
  assert.equal(C.candidates(e, { engarde: [], ftl: [] })[0].sourceUrl, e.officialSourceUrl);
});
test('recherche Engarde : prochains tournois paginés au-delà des vingt résultats récents', async () => {
  const calls = [];
  const found = await C.engardeList({
    get: async () => JSON.stringify({ events: [] }),
    tournaments: async (page, option) => {
      calls.push([page, option]);
      return JSON.stringify({ page, last: 2, events: [{ org: 'test', ev: 'p' + page }] });
    },
  });
  assert.deepEqual(calls, [
    [1, 'next'],
    [2, 'next'],
  ]);
  assert.equal(found.length, 2);
});
