const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedule, scheduleUrl } = require('../src/services/ftlTournament');
const { eventStart } = require('../src/services/eventStart');
const id = '11111111111111111111111111111111';
const url = `https://www.fencingtimelive.com/tournaments/eventSchedule/${id}`;
const session = (date, label, time = '9:00 AM') =>
  `<h5>${date}</h5><table class="scheduleTable"><tbody><tr id="ev_${id}"><td>${time}</td><td><a href="/events/view/${id}">${label}</a></td></tr></tbody></table>`;
const html = (rows) => '<div class="desktop tournName">Test World Cup</div>' + rows;
test('Day 1 et Day 2 : une seule épreuve, premier départ 9h Tokyo, même identifiant', () => {
  const x = parseSchedule(
    html(
      session('Saturday October 17, 2026', "Senior Men's Foil (Day 2)") +
        session('Thursday October 15, 2026', "Senior Men's Foil (Day 1)"),
    ),
    scheduleUrl(url + '#today'),
    'Asia/Tokyo',
  );
  assert.equal(x.events.length, 1);
  const e = x.events[0];
  assert.equal(e.eventId, id);
  assert.equal(e.event, "Senior Men's Foil");
  assert.equal(e.date, '2026-10-15');
  assert.equal(e.time, '9:00 AM');
  assert.equal(new Date(eventStart(e)).toISOString(), '2026-10-15T00:00:00.000Z');
  assert.equal(e.scheduleSessions.length, 2);
});
test('les doublons ambigus et les noms contradictoires restent refusés', () => {
  for (const label of ["Senior Men's Foil", "Senior Women's Foil (Day 2)", "Senior Men's Foil (Day 1)"])
    assert.throws(
      () =>
        parseSchedule(
          html(
            session('Thursday October 15, 2026', "Senior Men's Foil (Day 1)") +
              session('Saturday October 17, 2026', label),
          ),
          url,
          'Asia/Tokyo',
        ),
      /absente ou incohérente/,
    );
});
test('une épreuve sur un seul jour conserve son nom et son horaire', () => {
  const e = parseSchedule(html(session('Thursday October 15, 2026', 'Team Foil', '1:00 PM')), url, 'Asia/Tokyo')
    .events[0];
  assert.equal(e.event, 'Team Foil');
  assert.equal(e.format, 'TEAM');
  assert.equal(e.time, '1:00 PM');
});
