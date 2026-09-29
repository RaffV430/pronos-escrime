const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/services/engardeParser');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'engarde', name), 'utf8');

test('engarde-service links: tournament or any page of an event; other sites are not engarde', () => {
  assert.deepEqual(E.parseLink('https://engarde-service.com/tournament/life/idf1fm20mennecy'), {
    provider: 'engarde',
    kind: 'tournament',
    org: 'life',
    event: 'idf1fm20mennecy',
    url: 'https://engarde-service.com/tournament/life/idf1fm20mennecy',
  });
  const page = E.parseLink('https://www.engarde-service.com/competition/life/idf1fm20mennecy/fdm20/tableau16.htm#x');
  assert.equal(page.kind, 'competition');
  assert.equal(page.compe, 'fdm20');
  assert.equal(page.url, 'https://engarde-service.com/competition/life/idf1fm20mennecy/fdm20');
  assert.equal(
    E.parseLink('https://www.fencingtimelive.com/tournaments/eventSchedule/D70292EFE29248C587EAF462A9CDA20C'),
    null,
  );
  assert.equal(E.parseLink('https://engarde-service.evil.com/tournament/life/x'), null);
  assert.equal(E.parseLink('pas un lien'), null);
});

test('tournament events come from the official XML list, with venue and time zone', () => {
  const events = E.parseCompetitions(fixture('tournament-idf1fm20mennecy.xml'), {
    org: 'life',
    event: 'idf1fm20mennecy',
  });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.compe, e.event, e.date, e.time, e.format, e.city, e.timezone]),
    [
      ['fdm20', 'Fleuret Dames M20', '2026-09-20', '11:15', 'INDIVIDUAL', 'MENNECY', 'Europe/Paris'],
      ['fhm20', 'Fleuret Hommes M20', '2026-09-20', '09:15', 'INDIVIDUAL', 'MENNECY', 'Europe/Paris'],
    ],
  );
  assert.throws(
    () => E.parseCompetitions(fixture('tournament-idf1fm20mennecy.xml'), { org: 'life', event: 'autre' }),
    /autre tournoi/,
  );
});

test('roster: NOM Prénom, club and seed; a stable id is derived because Engarde has none', () => {
  const roster = E.parseRoster(fixture('fdm20-tireurs-extrait.html'));
  assert.equal(roster.length, 7);
  assert.deepEqual(roster[0], {
    id: E.entryId('BOLORE Mélisande', 'ANTONY'),
    name: 'BOLORE Mélisande',
    country: 'ANTONY',
    active: true,
    entryRanking: 1,
  });
  assert.match(roster[0].id, /^[a-f0-9]{32}$/);
});

test('pools: wins, losses and official indicator, with time and strip from the header', () => {
  const pools = E.parsePools(fixture('fdm20-poules-1-2.html'));
  assert.equal(pools.length, 2);
  assert.deepEqual(pools[0].time, { hour: 12, minute: 30 });
  assert.equal(pools[0].strip, '1');
  assert.equal(pools[0].complete, true);
  const bolore = pools[0].rows.find((f) => f.name === 'BOLORE Mélisande');
  assert.deepEqual([bolore.wins, bolore.losses, bolore.indicator], [6, 0, 21]);
  const li = pools[1].rows.find((f) => f.name === 'LI Helene Zhixuan');
  assert.deepEqual([li.wins, li.losses, li.indicator, li.firstResult], [5, 0, 19, true]);
  const marcel = pools[0].rows[0];
  assert.deepEqual([marcel.touches, marcel.received, marcel.position], [25, 17, 1]);
});

test('tableau: matches by official slot, byes skipped, winner, score, time and strip', () => {
  const { matches, rounds } = E.parseTableaus([fixture('fdm20-tableau64-top.html'), fixture('fdm20-tableau16.html')]);
  assert.deepEqual(
    rounds.map((r) => [r.round, r.previousRound]),
    [
      ['T64', null],
      ['T32', 'T64'],
      ['T16', 'T32'],
      ['T8', 'T16'],
      ['T4', 'T8'],
      ['T2', 'T4'],
    ],
  );
  // T64 n°1 : BOLORE exemptée (pas de match) ; n°2 : vrai match.
  assert.equal(
    matches.find((m) => m.sourceKey === 'T64:1'),
    undefined,
  );
  assert.deepEqual(
    (({ player1, player2, score1, score2, winner, strip, time }) => ({
      player1,
      player2,
      score1,
      score2,
      winner,
      strip,
      time,
    }))(matches.find((m) => m.sourceKey === 'T64:2')),
    {
      player1: 'BOUTCHOKI Imany',
      player2: 'PIERRAIN Lauryne',
      score1: 15,
      score2: 9,
      winner: 1,
      strip: '1',
      time: { hour: 14, minute: 15 },
    },
  );
  const t32 = matches.find((m) => m.sourceKey === 'T32:1');
  assert.deepEqual(
    [t32.player1, t32.player2, t32.score1, t32.score2, t32.winner],
    ['BOLORE Mélisande', 'BOUTCHOKI Imany', 15, 4, 1],
  );
  const final = matches.find((m) => m.sourceKey === 'T2:1');
  assert.deepEqual(
    [final.player1, final.player2, final.score1, final.score2, final.winner, final.strip],
    ['BOLORE Mélisande', 'LI Helene Zhixuan', 13, 15, 2, '1'],
  );
  assert.deepEqual(final.time, { hour: 17, minute: 0 });
  assert.equal(matches.filter((m) => m.round === 'T16').length, 8);
});

test('a match without a published winner stays open', () => {
  const html = fixture('fdm20-tableau16.html').replace(
    '<td class="HBD fencer quarter0"> LI Helene Zhixuan </td></tr><tr><td class="D placeNumber quarter3"> 3',
    '<td class="HBD fencer quarter0"></td></tr><tr><td class="D placeNumber quarter3"> 3',
  );
  const final = E.parseTableaus([html]).matches.find((m) => m.sourceKey === 'T2:1');
  assert.equal(final.isFinished, false);
  assert.equal(final.winner, null);
});

test('admin preview of an engarde-service tournament lists events, venue time zone and entries', async () => {
  const { preview } = require('../src/services/engardeTournament');
  const logged = [];
  const db = {
    auditLog: { create: async ({ data }) => (logged.push(data), { id: 42 }) },
    competition: { findUnique: async () => null },
  };
  const menu = (compe) =>
    ['tireurs.htm', 'poules1.htm', 'tableau128-32.htm', 'tableau16.htm', 'clasfinal.htm']
      .map((f) => `<a class="link-competition" href="/competition/life/idf1fm20mennecy/${compe}/${f}">x</a>`)
      .join('');
  const client = {
    competitions: async (org, event) => {
      assert.deepEqual([org, event], ['life', 'idf1fm20mennecy']);
      return fixture('tournament-idf1fm20mennecy.xml');
    },
    get: async (url) =>
      url.endsWith('/tireurs.htm')
        ? fixture('fdm20-tireurs-extrait.html')
        : url.includes('/tournament/')
          ? '<div class="tounament-titles"><strong class="tounament-title">IDF 1 Fleuret M20 - MENNECY</strong></div>'
          : menu(url.split('/').pop()),
  };
  const out = await preview(
    db,
    { sourceUrl: 'https://engarde-service.com/tournament/life/idf1fm20mennecy' },
    7,
    client,
  );
  assert.equal(out.provider, 'engarde');
  assert.equal(out.previewId, 42);
  assert.equal(out.timezone, 'Europe/Paris');
  assert.equal(out.tournament, 'IDF 1 Fleuret M20 - MENNECY');
  assert.equal(out.events[0].startsAt, '2026-09-20T09:15:00.000Z');
  assert.deepEqual(
    out.events.map((e) => [e.eventId, e.event, e.entries, e.published.tableau]),
    [
      ['life/idf1fm20mennecy/fdm20', 'Fleuret Dames M20', 7, true],
      ['life/idf1fm20mennecy/fhm20', 'Fleuret Hommes M20', 7, true],
    ],
  );
  assert.equal(logged[0].action, 'Aperçu tournoi engarde-service');
  const one = await preview(
    db,
    { sourceUrl: 'https://engarde-service.com/competition/life/idf1fm20mennecy/fhm20/poules1.htm' },
    7,
    client,
  );
  assert.deepEqual(
    one.events.map((e) => e.compe),
    ['fhm20'],
  );
});
