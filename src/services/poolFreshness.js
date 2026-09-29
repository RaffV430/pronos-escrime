// Contrôle FencingTimeLive immédiat au moment d'enregistrer un pronostic de poule.
// Des poules non suivies en direct peuvent être publiées d'un bloc entre deux contrôles automatiques
// (2 minutes) : sans ce contrôle, la saisie resterait ouverte alors que les résultats sont visibles.
// Lecture seule : le blocage officiel reste posé par le contrôle automatique, avancé ici.
const { load } = require('cheerio');
const { createClient } = require('./ftlClient');
const { clean } = require('./ftlParser');

const FRESH = 30000; // en deçà, le dernier contrôle automatique suffit
const TTL = 30000; // une lecture sert à tous les joueurs pendant 30 s
const TIMEOUT = 6000;
const cache = new Map(); // sourceUrl -> { at, promise }

// Positions (1..n) des tireurs qui ont au moins un score (ou un retrait) dans chaque poule de la page.
function startedPositions($) {
  const out = new Map();
  for (const table of $('table.poolTable').toArray()) {
    const number = Number(/^Pool #(\d+)$/.exec(clean($(table).parent().find('.poolNum').text()))?.[1]);
    if (!number) continue;
    const rows = $(table).find('tr.poolRow').toArray();
    const n = rows.length;
    const cells = rows.map((tr) =>
      $(tr)
        .children('td')
        .slice(2, 2 + n)
        .map((j, el) => clean($(el).text()))
        .get(),
    );
    const started = new Set();
    rows.forEach((tr, i) => {
      if ($(tr).find('.poolResultWDX').length) started.add(i + 1);
      for (let j = 0; j < n; j++)
        if (j !== i && (cells[i][j] || cells[j]?.[i])) {
          started.add(i + 1);
          started.add(j + 1);
        }
    });
    out.set(number, started);
  }
  return out;
}

async function readSource(sourceUrl, client) {
  const { poolMatrices } = require('./ftlSync');
  await client.login();
  const $ = await poolMatrices(load(await client.get(sourceUrl)), sourceUrl, client);
  return startedPositions($);
}

function observe(sourceUrl, { client, now = Date.now(), read = readSource } = {}) {
  const hit = cache.get(sourceUrl);
  if (hit && now - hit.at < TTL) return hit.promise;
  const promise = read(sourceUrl, client || createClient());
  cache.set(sourceUrl, { at: now, promise });
  promise.catch(() => cache.delete(sourceUrl));
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return promise;
}

// true : le tireur a commencé sur FTL (saisie à refuser) ; false : rien de publié ;
// null : contrôle inutile ou impossible (on applique alors la règle habituelle).
async function startedOnSource(pool, fencer, { now = new Date(), start = null, ...deps } = {}) {
  if (pool.lockMode !== 'FIRST_RESULT' || !pool.sourceUrl || !pool.sourcePoolNumber) return null;
  if (start && now.getTime() < start) return null;
  if (pool.sourceCheckedAt && now - new Date(pool.sourceCheckedAt) < FRESH) return null;
  let timer;
  try {
    const pools = await Promise.race([
      observe(pool.sourceUrl, { now: now.getTime(), ...deps }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), deps.timeout ?? TIMEOUT);
      }),
    ]);
    const started = pools.get(pool.sourcePoolNumber);
    return started ? started.has(fencer.position) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { startedOnSource, startedPositions, observe, _cache: cache, FRESH };
