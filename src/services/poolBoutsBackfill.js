// Relecture des matrices de poules (tous les assauts) pour les épreuves déjà importées, y compris archivées.
// Lecture seule de la source officielle : seule la colonne « bouts » est écrite, jamais les bilans, les
// verrous ni les points. Une poule dont la composition officielle diffère est laissée telle quelle.
const { load } = require('cheerio');
const { norm } = require('./ftlParser');
const { parsePools, pattern: ftlPattern } = require('./ftlPools');
const E = require('./engardeParser');

async function ftlObserved(url, client) {
  const { poolMatrices } = require('./ftlSync');
  const read = async () => poolMatrices(load(await client.get(url)), url, client);
  let $;
  try {
    $ = await read();
  } catch (error) {
    if (!client.login) throw error;
    await client.login();
    $ = await read();
  }
  return $('table.poolTable')
    .toArray()
    .flatMap((t) => {
      try {
        return [parsePools($.html($(t).parent()))[0]];
      } catch {
        return [];
      }
    });
}

function sameComposition(pool, observed) {
  const fencers = [...pool.fencers].sort((a, b) => a.position - b.position);
  return (
    Array.isArray(observed?.bouts) &&
    observed.rows.length === fencers.length &&
    observed.bouts.length === fencers.length &&
    fencers.every((f, i) => f.position === observed.rows[i].position && norm(f.name) === norm(observed.rows[i].name))
  );
}

async function backfillBouts(db, competitionId, { ftlClient, engardeClient } = {}) {
  const pools = await db.pool.findMany({
    where: { competitionId, sourceUrl: { not: null }, sourcePoolNumber: { not: null } },
    include: { fencers: true },
    orderBy: { id: 'asc' },
  });
  const summary = { pools: pools.length, updated: 0, unchanged: 0, warnings: [] };
  const urls = [...new Set(pools.map((p) => p.sourceUrl))];
  for (const url of urls) {
    let observed;
    try {
      if (ftlPattern.test(url)) {
        ftlClient ||= require('./ftlClient').createClient();
        observed = await ftlObserved(url, ftlClient);
      } else {
        engardeClient ||= require('./engardeTournament').createEngardeClient();
        observed = E.parsePools(await engardeClient.get(url)).filter((o) => !o.error);
      }
    } catch (error) {
      if (!error.status && !(error instanceof E.EngardeError)) throw error;
      summary.warnings.push(`${url} : ${error.message}`);
      continue;
    }
    for (const pool of pools.filter((p) => p.sourceUrl === url)) {
      const o = observed.find((x) => x.number === pool.sourcePoolNumber);
      if (!sameComposition(pool, o)) {
        summary.warnings.push(`${pool.name} : composition officielle différente, matrice non enregistrée.`);
        continue;
      }
      if (JSON.stringify(pool.bouts ?? null) === JSON.stringify(o.bouts)) {
        summary.unchanged++;
        continue;
      }
      await db.pool.update({ where: { id: pool.id }, data: { bouts: o.bouts } });
      summary.updated++;
    }
  }
  return summary;
}

module.exports = { backfillBouts, sameComposition };
