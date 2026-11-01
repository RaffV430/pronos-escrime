const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/officialRelayScores');
const E = 'A'.repeat(32),
  R = 'B'.repeat(32),
  B = 'C'.repeat(32);
const source = `https://www.fencingtimelive.com/tableaus/scores/${E}/${R}`;
const path = `/teammatches/details/${E}/${R}/${B}`;
const match = {
  competitionId: 700,
  sourceUrl: source,
  sourceKey: 'Semi-Finals:1',
  player1: 'TEAM ALPHA',
  player2: 'TEAM BRAVO',
  relayDetailsUrl: path,
};
const row = (a, b, ta, tb) =>
  `<tr><td class="tmPos">6</td><td><span class="tmCompName">SYNTH ONE</span></td><td class="tmTouches">${ta}</td><td class="tmScore">${a}</td><td class="tmScore">${b}</td><td class="tmTouches">${tb}</td><td><span class="tmCompName">SYNTH TWO</span></td><td>3</td></tr>`;
const html = (rows, a = 'TEAM ALPHA', b = 'TEAM BRAVO') =>
  `<table class="tmTable"><thead><tr><th>#</th><th>${a}</th><th>TS</th><th>Score</th><th>Score</th><th>TS</th><th>${b}</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>`;
const sample = html(row(5, 3, 5, 3) + row(8, 10, 3, 7) + row('', '', '', ''));
const footer = (a, b) =>
  `<tr class="tmTableFooter"><td></td><td></td><td></td><td>${a}</td><td>${b}</td><td></td><td></td><td></td></tr>`;
test('the total row published under a finished team match is ignored', () => {
  const scores = [
    [0, 5, 0, 5],
    [3, 10, 3, 5],
    [4, 15, 1, 5],
    [4, 20, 0, 5],
    [6, 25, 2, 5],
    [6, 30, 0, 5],
    [9, 35, 3, 5],
    [13, 40, 4, 5],
    [14, 45, 1, 5],
  ];
  const nine = scores.map(([a, b, ta, tb]) => row(a, b, ta, tb)).join('');
  const result = service.parseRelayScores(html(nine + footer('D14', 'V45')), match);
  assert.deepEqual(
    result.map((x) => [x.period, x.score1, x.score2]),
    scores.map(([a, b], i) => [i + 1, a, b]),
  );
  assert.equal(service.parseRelayScores(html(row(5, 3, 5, 3) + row('', '', '', '') + footer('', '')), match).length, 1);
  assert.throws(() => service.parseRelayScores(html(nine + row(14, 45, 0, 0) + footer('D14', 'V45')), match));
});
test('official relay totals, pending row and reversed teams are parsed without creating touches', () => {
  const result = service.parseRelayScores(sample, match);
  assert.deepEqual(
    result.map((x) => [x.period, x.score1, x.score2]),
    [
      [1, 5, 3],
      [2, 8, 10],
    ],
  );
  assert.equal(result[0].source, 'official-relay-total');
  assert.equal(result[0].by, undefined);
  const reverse = service.parseRelayScores(sample, { ...match, player1: match.player2, player2: match.player1 });
  assert.deepEqual([reverse[1].score1, reverse[1].score2, reverse[1].fencer1Name], [10, 8, 'SYNTH TWO']);
});
test('foreign source, event, round and ambiguous or inconsistent score sheets are refused', () => {
  assert.equal(service.detailsPath(path, source), path);
  for (const value of [
    `https://evil.example${path}`,
    path + '?x=1',
    path.replace(E, 'D'.repeat(32)),
    path.replace(R, 'D'.repeat(32)),
  ])
    assert.equal(service.detailsPath(value, source), null);
  assert.throws(() => service.parseRelayScores(html(row(5, 3, 5, 3), 'OTHER', 'TEAM BRAVO'), match));
  assert.throws(() => service.parseRelayScores(html(row(6, 3, 6, 3)), match));
  assert.throws(() => service.parseRelayScores(html(row(5, 3, 4, 3)), match));
  assert.throws(() => service.parseRelayScores(html(row('', '', '', '') + row(8, 10, 3, 7)), match));
  assert.throws(() => service.parseRelayScores(sample + sample, match));
});
test('optional scheduled reads are bounded, cached and never write a match or points', async () => {
  service._cache.clear();
  let calls = 0;
  const client = {
    get: async (url) => {
      assert.equal(url, path + '/data');
      calls++;
      return sample;
    },
  };
  const c = { id: 700, podiumFormat: 'TEAM' },
    observation = { sourceUrl: source, matches: [match] };
  await service.refresh(c, observation, client, 100000);
  assert.equal(calls, 1);
  assert.equal(service.forMatch(match, 100001).length, 2);
  const reversed = service.forMatch({ ...match, player1: match.player2, player2: match.player1 }, 100001);
  assert.deepEqual([reversed[0].score1, reversed[0].score2, reversed[0].fencer1Name], [3, 5, 'SYNTH TWO']);
  await service.refresh(c, observation, client, 110000);
  assert.equal(calls, 1);
  await service.refresh(
    c,
    observation,
    {
      get: async () => {
        throw Error('offline');
      },
    },
    170000,
  );
  assert.equal(service.forMatch(match, 170001).length, 2);
  assert.deepEqual(service.forMatch({ ...match, player1: 'OTHER' }, 170001), []);
  assert.deepEqual(service.forMatch(match, 100000 + 6 * 3600000 + 1), []);
  await service.refresh({ ...c, podiumFormat: 'INDIVIDUAL' }, observation, client, 999999);
  assert.equal(calls, 1);
  service._cache.clear();
  await service.refresh(
    c,
    { ...observation, matches: [match, { ...match, sourceKey: '2' }, { ...match, sourceKey: '3' }] },
    client,
    200000,
  );
  assert.equal(calls, 3);
});
test('the details link is read from the corresponding tableau score cell', () => {
  const { readFileSync } = require('node:fs');
  const { load } = require('cheerio');
  const { parseTable } = require('../src/services/ftlParser');
  const $ = load(readFileSync(`${__dirname}/fixtures/ftl-team.html`, 'utf8'));
  $('.tsco').each((i, e) =>
    $(e).append(
      `<span class="tmdl"><a href="/teammatches/details/${E}/${R}/${String(i + 1).padStart(32, '0')}">[Match Details]</a></span>`,
    ),
  );
  const roster = [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .toArray()
            .map((n) => $(n).text())
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
  const parsed = parseTable($.html(), { date: '2026-09-27', roster });
  assert.ok(parsed.matches.length > 0);
  assert.ok(parsed.matches.every((m) => m.relayDetailsUrl));
  assert.equal(new Set(parsed.matches.map((m) => m.relayDetailsUrl)).size, parsed.matches.length);
});
