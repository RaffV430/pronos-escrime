const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/services/engardeParser');
const { officialStandings, finalStanding } = require('../src/services/officialStandings');
const base = 'https://engarde-service.com/competition/test/weekend/main';
const ranking = `<table class="liste"><tr><th>Rg</th><th>Nom</th><th>Prénom</th><th>Club</th><th>Vic/match</th><th>Ind.</th><th>TD</th></tr>
<tr><td>1</td><td>TEST</td><td>Alex</td><td>CLUB A</td><td>1,000</td><td>+20</td><td>30</td></tr>
<tr><td>1</td><td>TEST</td><td>Bob</td><td>CLUB B</td><td>1,000</td><td>+20</td><td>30</td></tr></table>`;
const menu = `<a class="link-competition" href="/competition/test/weekend/main/claspoules1.htm">Classement</a>`;
function fixture(id) {
  const c = {
    id,
    podiumRoster: [
      { id: 'a', name: 'TEST Alex', club: 'CLUB A' },
      { id: 'b', name: 'TEST Bob', club: 'CLUB B' },
    ],
    resultsVerifiedAt: new Date('2026-10-18'),
    resultsSourceUrl: `${base}/clasfinal.htm`,
    officialPodium: {
      finalConfirmed: true,
      classification: [
        { entryId: 'a', rank: 1 },
        { entryId: 'b', rank: 2 },
      ],
    },
  };
  const db = {
    competition: { findUnique: async () => structuredClone(c) },
    pool: { findMany: async () => [{ name: 'Tour 4 · J2 · Poule 1', sourceUrl: `${base}/poules1.htm` }] },
  };
  let calls = 0,
    fail = false;
  const client = {
    get: async (url) => {
      calls++;
      if (fail) throw Error('offline');
      return url === base ? menu : ranking;
    },
  };
  return {
    c,
    db,
    client,
    calls: () => calls,
    fail: () => {
      fail = true;
    },
  };
}
test('pool ranking uses published positions, ties and values without inventing a tie-break', () => {
  const rows = E.parsePoolRanking(ranking);
  assert.deepEqual(
    rows.map((r) => r.place),
    ['1', '1'],
  );
  assert.deepEqual(rows[0].stats, { ratio: '1,000', indicator: '+20', touches: '30' });
  assert.throws(() => E.parsePoolRanking('<p>not published</p>'));
  const pages = E.competitionPages(menu, { org: 'test', event: 'weekend', compe: 'main' });
  assert.deepEqual(pages.rankings, [`${base}/claspoules1.htm`]);
});
test('final classification is exposed only when verified and resolves stable roster IDs', () => {
  const f = fixture(101);
  assert.equal(finalStanding(f.c).rows.length, 2);
  assert.equal(finalStanding({ ...f.c, officialPodium: { finalConfirmed: false } }), null);
});
test('on-demand consultation preserves data, merges concurrent requests, caches and retains dated stale results on outage', async () => {
  const f = fixture(102),
    before = structuredClone(f.c);
  const opts = { clientFactory: () => f.client, now: 1000 };
  const [a, b] = await Promise.all([officialStandings(f.db, 102, opts), officialStandings(f.db, 102, opts)]);
  assert.deepEqual(a, b);
  assert.equal(f.calls(), 2);
  assert.equal(a.standings[1].label, 'Après le tour 4 de poules · J2');
  assert.equal(a.standings[1].rows[0].entryId, 'a');
  await officialStandings(f.db, 102, opts);
  assert.equal(f.calls(), 2);
  f.fail();
  const stale = await officialStandings(f.db, 102, { ...opts, now: 4000000 });
  assert.equal(stale.standings[1].stale, true);
  assert.equal(stale.standings[1].checkedAt, a.standings[1].checkedAt);
  assert.ok(stale.warnings.length);
  assert.deepEqual(f.c, before);
});
test('unrecognized identities do not produce an invented ranking; non-Engarde pools make no external reads', async () => {
  const f = fixture(103);
  f.c.podiumRoster = [];
  assert.equal((await officialStandings(f.db, 103, { clientFactory: () => f.client })).standings.length, 0);
  const g = fixture(104);
  g.db.pool.findMany = async () => [
    { name: 'Poule1', sourceUrl: 'https://www.fencingtimelive.com/pools/scores/test/test' },
  ];
  assert.equal((await officialStandings(g.db, 104, { clientFactory: () => g.client })).standings.length, 1);
  assert.equal(g.calls(), 0);
});
