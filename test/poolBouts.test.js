const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const E = require('../src/services/engardeParser');
const { parsePools } = require('../src/services/ftlPools');
const fixture = (f) => fs.readFileSync(`${__dirname}/fixtures/${f}`, 'utf8');

// Chaque assaut de la matrice doit être cohérent avec le bilan du tireur et le score réciproque.
function check(pool) {
  const n = pool.rows.length;
  assert.equal(pool.bouts.length, n);
  pool.bouts.forEach((row, i) => {
    assert.equal(row.length, n);
    assert.equal(row[i], null);
    const r = pool.rows[i];
    if (r.absent) return assert.ok(row.every((c) => c === null));
    const wins = row.filter((c) => c?.startsWith('V')).length;
    if (pool.complete) assert.equal(wins, r.wins);
    row.forEach((c, j) => {
      const o = pool.bouts[j][i];
      if (i !== j && pool.complete && !pool.rows[j].absent) assert.ok(c && o, `assaut ${i + 1}-${j + 1}`);
      if (c && o) assert.notEqual(c[0], o[0]);
    });
  });
}

test('FencingTimeLive : matrice complète des assauts, retrait sans assaut inventé', () => {
  for (const f of ['cism-pools-corrected.html', 'ftl-pool-medical-withdrawal.html'])
    parsePools(fixture(f)).forEach(check);
  const [pool] = parsePools(fixture('ftl-pool-medical-withdrawal.html'));
  assert.ok(pool.bouts[6].every((c) => c === null));
  assert.ok(pool.bouts.every((row) => row[6] === null));
});

test('engarde : matrice complète, touches de la victoire et de la défaite', () => {
  const pools = E.parsePools(fixture('engarde/fdm20-poules-1-2.html'));
  pools.forEach(check);
  const [p] = pools;
  const marcel = p.bouts[0].filter(Boolean);
  const touches = marcel.reduce((s, c) => s + (Number(c.slice(1)) || 5), 0);
  assert.equal(touches, p.rows[0].touches);
});
