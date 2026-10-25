// Official relay totals are display-only and never become individual touches or match results.
const { load } = require('cheerio');
const { norm } = require('./ftlParser');
const ORIGIN = 'https://www.fencingtimelive.com';
const version = (m) => `${Boolean(m.isFinished)}:${m.score1}:${m.score2}`;
const cache = new Map();
const key = (c, m, source) => `${c}:${m.sourceUrl || source}:${m.sourceKey}:${norm(m.player1)}:${norm(m.player2)}`;
function detailsPath(value, source) {
  try {
    const url = new URL(value, ORIGIN),
      parent = new URL(source);
    const ids = /^\/tableaus\/scores\/([a-f0-9]{32})\/([a-f0-9]{32})$/i.exec(parent.pathname);
    const detail = /^\/teammatches\/details\/([a-f0-9]{32})\/([a-f0-9]{32})\/([a-f0-9]{32})$/i.exec(url.pathname);
    return parent.origin === ORIGIN &&
      url.origin === ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ids &&
      detail &&
      ids[1].toLowerCase() === detail[1].toLowerCase() &&
      ids[2].toLowerCase() === detail[2].toLowerCase()
      ? url.pathname
      : null;
  } catch {
    return null;
  }
}
function parseRelayScores(html, match) {
  const $ = load(html),
    table = $('table.tmTable');
  if (table.length !== 1) throw new Error('Bilan des relais non reconnu.');
  const heads = table
    .find('thead th')
    .toArray()
    .map((e) => $(e).text().trim());
  if (heads.length !== 8) throw new Error('Colonnes des relais non reconnues.');
  const forward = norm(heads[1]) === norm(match.player1) && norm(heads[6]) === norm(match.player2);
  const reverse = norm(heads[1]) === norm(match.player2) && norm(heads[6]) === norm(match.player1);
  if (!forward && !reverse) throw new Error('Équipes du bilan différentes de la rencontre.');
  const rows = table.find('tbody tr').toArray();
  if (rows.length > 9) throw new Error('Nombre de relais inattendu.');
  let previous = [0, 0],
    incomplete = false;
  return rows.flatMap((row, i) => {
    const cells = $(row).children('td');
    if (cells.length !== 8) throw new Error('Ligne de relais non reconnue.');
    const values = [cells.eq(2).text(), cells.eq(3).text(), cells.eq(4).text(), cells.eq(5).text()].map((s) =>
      s.trim(),
    );
    if (values.every((v) => v === '')) {
      incomplete = true;
      return [];
    }
    if (incomplete || values.some((v) => !/^\d+$/.test(v))) throw new Error('Relais incomplet ou ambigu.');
    const [ts1, s1, s2, ts2] = values.map(Number),
      period = i + 1;
    if (
      s1 > period * 5 ||
      s2 > period * 5 ||
      s1 < previous[0] ||
      s2 < previous[1] ||
      s1 - previous[0] !== ts1 ||
      s2 - previous[1] !== ts2
    )
      throw new Error('Scores cumulés des relais incohérents.');
    const names = cells
      .find('.tmCompName')
      .toArray()
      .map((e) => $(e).text().trim());
    if (names.length !== 2 || names.some((n) => !n)) throw new Error('Tireurs du relais non identifiés.');
    previous = [s1, s2];
    return [
      {
        period,
        score1: reverse ? s2 : s1,
        score2: reverse ? s1 : s2,
        fencer1Name: names[reverse ? 1 : 0],
        fencer2Name: names[reverse ? 0 : 1],
        source: 'official-relay-total',
      },
    ];
  });
}
async function refresh(c, observation, client, now = Date.now()) {
  if (c.podiumFormat !== 'TEAM') return;
  const candidates = observation.matches
    .map((m) => ({
      m,
      k: key(c.id, m, observation.sourceUrl),
      path: detailsPath(m.relayDetailsUrl, m.sourceUrl || observation.sourceUrl),
    }))
    .filter(
      (x) =>
        x.path &&
        (now - (cache.get(x.k)?.attempt || 0) >= 60000 || (x.m.isFinished && cache.get(x.k)?.version !== version(x.m))),
    )
    .sort(
      (a, b) =>
        Number(a.m.isFinished) - Number(b.m.isFinished) ||
        (cache.get(a.k)?.attempt || 0) - (cache.get(b.k)?.attempt || 0),
    );
  // Two small optional reads per scheduled control, no viewer-triggered official request.
  for (const { m, k, path } of candidates.slice(0, 2)) {
    const previous = cache.get(k);
    cache.set(k, { ...previous, attempt: now, version: version(m) });
    try {
      const expected = `${path}/data`;
      const relays = parseRelayScores(await client.get(expected), m);
      cache.set(k, { attempt: now, at: now, relays, version: version(m) });
    } catch {
      /* Optional display data: keep verified totals, never fail the official import. */
    }
  }
  while (cache.size > 500) cache.delete(cache.keys().next().value);
}
function forMatch(match, now = Date.now()) {
  const direct = cache.get(key(match.competitionId, match, match.sourceUrl));
  const reverse =
    !direct &&
    cache.get(key(match.competitionId, { ...match, player1: match.player2, player2: match.player1 }, match.sourceUrl));
  const stored = direct || reverse;
  if (!stored?.relays || now - stored.at > 6 * 3600000) return [];
  const relays = reverse
    ? stored.relays.map((r) => ({
        ...r,
        score1: r.score2,
        score2: r.score1,
        fencer1Name: r.fencer2Name,
        fencer2Name: r.fencer1Name,
      }))
    : stored.relays;
  const last = relays.at(-1);
  if (match.isFinished && last?.period === 9 && (last.score1 !== match.score1 || last.score2 !== match.score2))
    return [];
  return relays;
}
module.exports = { detailsPath, parseRelayScores, refresh, forMatch, _cache: cache };
