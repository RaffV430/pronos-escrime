const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs');
const { load } = require('cheerio');
const { parsePools, applyPool } = require('../src/services/ftlPools');
const { localTime } = require('../src/services/localTime');
const { parseRoster, preview, save } = require('../src/services/ftlConfiguration');
const { captureRankings, rankProgress } = require('../src/services/rankingHistory');
const fixture = fs.readFileSync(`${__dirname}/fixtures/ftl-pools.html`, 'utf8');
test('all 28 official pools: 194 athletes and reciprocal scores/stats verified', () => {
  const pools = parsePools(fixture);
  assert.equal(pools.length, 28);
  assert.equal(
    pools.reduce((n, p) => n + p.rows.length, 0),
    194,
  );
  assert.ok(pools.every((p) => p.complete && !p.ambiguous));
  assert.equal(pools[0].rows[1].wins, 5);
  assert.equal(pools[0].rows[1].indicator, 20);
});
function empty() {
  const $ = load(fixture);
  $('table.poolTable').slice(1).parent().remove();
  $('.poolScore').text('');
  $('.poolResult').text('0');
  return $;
}
test('zeros and blank cells never become results; D0 locks both without inventing reciprocal balance', () => {
  const $ = empty();
  assert.ok(parsePools($.html())[0].rows.every((r) => !r.firstResult));
  $('.poolRow').eq(0).children('td').eq(3).text('D0');
  const p = parsePools($.html())[0];
  assert.equal(p.complete, false);
  assert.equal(p.ambiguous, true);
  assert.deepEqual(
    p.rows.filter((r) => r.firstResult).map((r) => r.position),
    [1, 2],
  );
  assert.equal(p.rows[0].indicator, null);
  assert.equal(p.rows[1].wins, null);
  $('.poolRow').eq(1).children('td').eq(2).text('V5');
  const completePair = parsePools($.html())[0];
  assert.equal(completePair.ambiguous, false);
  assert.equal(completePair.rows[0].losses, 1);
  assert.equal(completePair.rows[0].wins, 0);
  assert.equal(completePair.rows[0].indicator, -5);
});
test('incoherent reciprocals, diagonal, statistics and exclusions reject import', () => {
  for (const [selector, value] of [
    ['.poolScore', 'V5'],
    ['.poolScoreFill', 'D0'],
    ['.poolResult', '99'],
    ['.poolScore', 'Excluded'],
  ]) {
    const $ = load(fixture);
    $(selector).first().text(value);
    assert.throws(() => parsePools($.html()));
  }
});
test('pool guard preserves identities and old timestamps; partial never globally locks or scores predictions', async () => {
  const $ = empty();
  $('.poolRow').eq(0).children('td').eq(3).text('D0');
  const observed = parsePools($.html())[0];
  const stamp = new Date('2026-09-01'),
    snapshot = {
      id: 1,
      competitionId: 1,
      name: 'Poule 1',
      sourceUrl: 'url',
      sourcePoolNumber: 1,
      lockMode: 'FIRST_RESULT',
      isLocked: false,
      isFinal: false,
      fencers: observed.rows.map((r, i) => ({
        id: i + 1,
        name: r.name,
        position: r.position,
        firstResultAt: i === 0 ? stamp : null,
      })),
    };
  const updates = [],
    db = {
      $queryRaw: async () => [],
      pool: {
        findUnique: async () => snapshot,
        update: async ({ data }) => {
          // Score réciproque manquant : ni fraîcheur, ni blocage global, ni clôture (la piste peut être notée).
          for (const k of ['sourceCheckedAt', 'isFinal', 'isLocked']) assert.ok(!(k in data), k);
        },
      },
      poolFencer: {
        updateMany: async ({ where, data }) => {
          updates.push({ where, data });
          return { count: 1 };
        },
      },
      poolPrediction: { findMany: () => assert.fail('no points on partial') },
    };
  const result = await applyPool(db, snapshot, observed, new Date());
  assert.equal(result.locks, 1);
  assert.ok(!('firstResultAt' in updates[0].data));
  assert.equal(updates[0].where.name, snapshot.fencers[0].name);
  await assert.rejects(
    applyPool(
      { ...db, pool: { findUnique: async () => ({ ...snapshot, sourceUrl: 'changed' }) } },
      snapshot,
      observed,
      new Date(),
    ),
    /modifiée/,
  );
});
test('timezones convert actual local time and reject DST ambiguity and gaps', () => {
  assert.equal(localTime('2026-09-27', 9, 0, 'Europe/Istanbul').toISOString(), '2026-09-27T06:00:00.000Z');
  assert.equal(localTime('2026-12-01', 9, 0, 'Europe/Paris').toISOString(), '2026-12-01T08:00:00.000Z');
  assert.throws(() => localTime('2026-10-25', 2, 30, 'Europe/Paris'), /ambigu/);
  assert.throws(() => localTime('2026-03-29', 2, 30, 'Europe/Paris'), /ambigu/);
});
test('roster uses full names, unique IDs, positive entry ranks and scratched status', () => {
  const a = { id: '1234567890ABCDEF', name: 'DUPONT Alice', country: 'FRA', rank: 4, status: 'CheckedIn' },
    b = { ...a, id: 'FEDCBA0987654321', name: 'DUPONT Anne', rank: null, status: 'Scratched' };
  const r = parseRoster([b, a]);
  assert.equal(r[0].name, 'DUPONT Alice');
  assert.equal(r[1].active, false);
  assert.equal(r[1].entryRanking, null);
  assert.throws(() => parseRoster([a, a]), /dupliqués/);
  assert.throws(() => parseRoster([{ ...a, rank: -1 }]), /Rang/);
});
test('configuration rejects external URLs before login and expired or foreign previews', async () => {
  await assert.rejects(
    preview({}, { sourceUrl: 'https://evil.example/test' }, 1, { login: () => assert.fail() }),
    (e) => e.status === 400,
  );
  const db = {
    $queryRaw: async () => [],
    auditLog: {
      findFirst: async () => null,
      findUnique: async () => ({ actorId: 2, targetType: 'FtlSetupPreview', createdAt: new Date() }),
    },
  };
  db.$transaction = (fn) => fn(db);
  await assert.rejects(save(db, { previewId: 1 }, 1), /expiré/);
});
test('ranking progress is based on two server snapshots and ties preserve zero change', async () => {
  const db = {
    auditLog: {
      findMany: async () => [
        { createdAt: new Date(200), after: { rows: [{ id: 7, rank: 1 }] } },
        { createdAt: new Date(100), after: { rows: [{ id: 7, rank: 3 }] } },
      ],
    },
  };
  assert.equal((await rankProgress(db, 1, 7)).change, 2);
  assert.equal(await rankProgress(db, 1, 9), null);
});
test('verified future event preview and creation preserve full roster and are idempotent', async () => {
  const id = 'ABCDEF0123456789ABCDEF0123456789',
    round = '0123456789ABCDEF0123456789ABCDEF',
    sourceUrl = `https://www.fencingtimelive.com/tableaus/scores/${id}/${round}`;
  const header =
    '<div class="desktop tournName">World Cup</div><div class="desktop eventName">Junior Team Men\'s Foil</div><div class="desktop eventTime">Sunday, September 27, 2026 9:00 AM</div>';
  const entries = [
    { id: '1234567890ABCDEF', name: 'FRANCE', country: 'FRA', rank: 1, status: 'CheckedIn' },
    { id: 'FEDCBA0987654321', name: 'ITALY', country: 'ITA', rank: 2, status: 'CheckedIn' },
  ];
  const logs = [],
    competitions = [];
  let tournaments = 0;
  const db = {
    $queryRaw: async () => [],
    auditLog: {
      create: async ({ data }) => {
        const r = { id: logs.length + 1, createdAt: new Date(), ...data };
        logs.push(r);
        return r;
      },
      findUnique: async ({ where }) => logs.find((r) => r.id === where.id),
      findFirst: async ({ where }) => logs.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)),
    },
    competition: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const c = { id: 70, ...data };
        competitions.push(c);
        return c;
      },
      update: async ({ data }) => Object.assign(competitions[0], data),
    },
    tournament: {
      create: async ({ data }) => {
        tournaments++;
        return { id: 30, ...data };
      },
    },
  };
  db.$transaction = (fn) => fn(db);
  const client = {
    login: async () => {},
    get: async (path) =>
      path === sourceUrl
        ? header + `<a href="/events/competitors/${id}">Fencers</a><a href="${sourceUrl}">Tableau</a>`
        : path.endsWith(`/competitors/${id}`)
          ? header + `<table id="compList" data-url="/events/competitors/data/${id}"></table>`
          : entries,
  };
  const result = await preview(
    db,
    { sourceUrl, date: '2026-09-27', timezone: 'Europe/Istanbul', format: 'TEAM' },
    1,
    client,
  );
  assert.equal(result.entries.length, 2);
  const saved = await save(db, { previewId: result.previewId, name: 'Fleuret hommes' }, 1);
  assert.equal(saved.competitionId, 70);
  assert.equal(competitions[0].podiumRoster[0].name, 'FRANCE');
  assert.deepEqual(await save(db, { previewId: result.previewId }, 1), saved);
  assert.equal(tournaments, 1);
  assert.equal(competitions.length, 1);
});
test('official lazy pool placeholders load every matrix before parsing', async () => {
  const { poolMatrices } = require('../src/services/ftlSync'),
    id = '07A7D819A07D44FA943BA793177B78AC',
    url =
      'https://www.fencingtimelive.com/pools/scores/3E02F3DE23C54C7683C06B07F23E85F4/2D104659D71C4335A2D95211E4343ED7';
  const $ = load(fixture),
    html = $('table.poolTable').first().parent().html(),
    calls = [];
  const result = await poolMatrices(load(`<div id="pool_${id}"></div>`), url, {
    get: async (u) => {
      calls.push(u);
      return html;
    },
  });
  assert.equal(parsePools(result.html()).length, 1);
  assert.equal(calls[0], `${url}/${id}?dbut=true`);
  await assert.rejects(
    poolMatrices(load('<div id="pool_invalid"></div>'), url, { get: () => assert.fail() }),
    /publiées/,
  );
});
