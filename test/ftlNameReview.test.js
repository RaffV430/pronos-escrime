const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTable } = require('../src/services/ftlParser');
const R = require('../src/services/ftlNameReview');
const html = `<table class="elimTableau"><tr><th>Finals</th><th>Winner</th></tr><tr><td class="tbb"><span class="tcln">ALPHA</span> <span class="tcfn">Roy</span></td><td></td></tr><tr><td></td><td class="tbb"><span class="tcln">ALPHA</span> <span class="tcfn">Roy</span></td></tr><tr><td class="tbbr"><span class="tcln">BETA</span> <span class="tcfn">Sam</span></td><td><span class="tsco">15 - 9</span></td></tr></table>`;
const roster = [
  { id: 'a', name: 'ALPHA Roy J.', country: 'USA' },
  { id: 'b', name: 'BETA Sam', country: 'FRA' },
];
const options = { roster, date: '2026-10-15', maxScore: 15 };
const alias = { sourceName: 'ALPHA Roy', entryId: 'a', entryName: 'ALPHA Roy J.' };
test('correspondance explicite : adversaires et vainqueur utilisent l’identité conservée', () => {
  assert.throws(() => parseTable(html, options), /absent/);
  const before = structuredClone(roster);
  const result = parseTable(html, { ...options, nameAliases: [alias] });
  assert.equal(result.matches[0].player1, 'ALPHA Roy J.');
  assert.equal(result.matches[0].winner, 1);
  assert.equal(result.matches[0].score1, 15);
  assert.equal(result.matches[0].score2, 9);
  assert.deepEqual(roster, before);
  const existing = { id: 99, ...result.matches[0], sourceUrl: 'source' };
  const plan = require('../src/services/ftlSync').planMatches([existing], { ...result, sourceUrl: 'source' });
  assert.equal(plan[0].current.id, 99);
  assert.equal(plan.conflicts?.length || 0, 0);
  for (const nameAliases of [
    [],
    [{ ...alias, entryId: 'absent' }],
    [{ ...alias, entryName: 'Ancien nom' }],
    [alias, alias],
  ])
    assert.throws(() => parseTable(html, { ...options, nameAliases }), /absent/);
  assert.throws(
    () => parseTable(html, { ...options, roster: roster.map((e) => ({ ...e, active: false })), nameAliases: [alias] }),
    /absent/,
  );
});
function database() {
  let saved = [],
    warnings = ['T256 · match 120 : Nom officiel ambigu ou absent des engagés : ALPHA Roy.'];
  const c = {
    id: 20,
    name: 'TEST',
    podiumRoster: structuredClone(roster),
    ftlEventId: 'A'.repeat(32),
    rosterSourceUrl: 'https://www.fencingtimelive.com/events/competitors/' + 'A'.repeat(32),
  };
  const audit = [];
  const db = {
    $queryRaw: async () => [],
    competition: { findUnique: async () => c },
    appSetting: {
      findUnique: async () => ({ value: saved }),
      upsert: async ({ update }) => {
        saved = update.value;
      },
      update: async ({ data }) => {
        saved = data.value;
      },
    },
    auditLog: {
      findFirst: async () => ({ after: { warnings } }),
      create: async ({ data }) => {
        audit.push(data);
      },
    },
    $transaction: async (fn) => fn(db),
  };
  return {
    db,
    c,
    audit,
    change: () => {
      warnings = [];
    },
  };
}
test('confirmation versionnée, isolée et réversible, sans écriture de joueur/match/points', async () => {
  const { db, c, audit, change } = database(),
    before = structuredClone(c);
  const first = await R.review(db, 20),
    body = {
      sourceName: alias.sourceName,
      entryId: 'a',
      reason: 'Même personne vérifiée sur la source',
      confirm: true,
      version: first.version,
    };
  await assert.rejects(R.confirm(db, 20, { ...body, confirm: false }, 1), /Confirmez/);
  await assert.rejects(R.confirm(db, 20, { ...body, version: 'old' }, 1), /changé/);
  await assert.rejects(R.confirm(db, 20, { ...body, entryId: 'unknown' }, 1), /ambigu/);
  await assert.rejects(R.confirm(db, 20, { ...body, sourceName: 'AUTRE' }, 1), /avertissements/);
  await R.confirm(db, 20, body, 1);
  assert.deepEqual(await R.aliases(db, 20), [alias]);
  assert.deepEqual(c, before);
  assert.equal(audit[0].actorId, 1);
  const next = await R.review(db, 20);
  await assert.rejects(R.remove(db, 20, { sourceName: alias.sourceName, version: first.version }, 1), /changé/);
  await R.remove(db, 20, { sourceName: alias.sourceName, version: next.version }, 1);
  assert.deepEqual(await R.aliases(db, 20), []);
  change();
  await assert.rejects(R.confirm(db, 20, body, 1), /changé/);
});
