const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('cheerio');
const { poolRoundContext, syncPools, observe } = require('../src/services/ftlSync');
const { parsePools } = require('../src/services/ftlPools');
const { samples, url, config, page, eventId } = require('./fixtures/ftl-marathon/pages');
test('FTL Marathon : trois matrices complètes et numérotation distincte des tours', () => {
  for (const sample of samples) {
    const $ = load(page(sample));
    const context = poolRoundContext($, url(sample), config);
    assert.equal(context.round, sample.round);
    assert.equal(context.label(1), sample.round === 1 ? 'Poule 1' : `Tour ${sample.round} · Poule 1`);
    assert.equal(context.date, sample.round === 1 ? '2026-01-31' : null);
    assert.equal(parsePools($.html())[0].complete, true);
  }
});
test('FTL : les tours de poules sont découverts sans inventer de source ni suivre une autre épreuve', () => {
  const $ = load(
    page(samples[1]) +
      '<a href="https://www.fencingtimelive.com/pools/scores/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB">Pools</a>',
  );
  assert.deepEqual(poolRoundContext($, url(samples[1]), config).sources, samples.map(url));
  assert.throws(
    () =>
      poolRoundContext(
        $,
        'https://www.fencingtimelive.com/pools/scores/' + eventId + '/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        config,
      ),
    /absent/,
  );
});
test('FTL : une poule manuelle ambiguë reste protégée, même au deuxième tour', async () => {
  let writes = 0;
  const original = { id: 1, name: 'Saisie manuelle', sourceUrl: null, fencers: [{ name: 'KOESTERS Florentine' }] };
  const db = {
    pool: { findMany: async () => [original] },
    $transaction: async () => {
      writes++;
      throw new Error('Écriture interdite');
    },
  };
  const c = {
    id: 1,
    rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${eventId}`,
    podiumRoster: samples[1].rows.map(([name]) => ({ name })),
  };
  const result = await syncPools(db, c, { ...config, poolSources: [url(samples[1])] }, null, {
    get: async (u) => {
      if (u !== url(samples[1])) throw new Error('Source hors scénario');
      return page(samples[1]);
    },
  });
  assert(result.warnings.includes('Tour 2 · Poule 1 déjà présente sans correspondance de source certaine.'));
  assert.equal(writes, 0);
  assert.equal(original.fencers[0].name, 'KOESTERS Florentine');
});
test('FTL : repêchages détectés avant import du tableau principal incomplet', async () => {
  const sourceUrl = `https://www.fencingtimelive.com/tableaus/scores/${eventId}/DDE3514325614805A7964AA0BFF3B666`;
  const c = {
    name: config.event,
    podiumFormat: 'INDIVIDUAL',
    rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${eventId}`,
    podiumRoster: samples[0].rows.map(([name], i) => ({ id: String(i), name })),
  };
  await assert.rejects(
    () =>
      observe(
        c,
        [],
        {
          get: async (u) =>
            u.endsWith('/trees')
              ? [
                  { treeNum: 0, name: 'Primary Tableau' },
                  { treeNum: 1, name: 'T64 Rep 1/2 (C)' },
                ]
              : page(samples[0]),
        },
        { ...config, name: c.name, sourceUrl },
        true,
      ),
    /repêchages/,
  );
});
