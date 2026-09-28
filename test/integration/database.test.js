// Tests d'intégration sur un vrai PostgreSQL (lancés en CI, ou localement avec
// TEST_DATABASE_URL). La base est reconstruite en rejouant l'historique manuel
// (prisma/legacy-order.txt), identique à la production, puis les migrations
// automatiques de prisma/auto/ sont appliquées et le schéma vérifié.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
const root = path.join(__dirname, '../..');
const opts = { skip: url ? false : 'TEST_DATABASE_URL non défini' };

let pg, admin;
async function connect() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const sql = (strings, values) => strings.reduce((s, p, i) => s + p + (i < values.length ? `$${i + 1}` : ''), '');
  const db = {
    $queryRaw: async (s, ...v) => (await client.query(sql(s, v), v)).rows,
    $executeRaw: async (s, ...v) => (await client.query(sql(s, v), v)).rowCount,
    $executeRawUnsafe: async (s) => (await client.query(s)).rowCount,
    $transaction: async (fn) => {
      await client.query('BEGIN');
      try {
        const result = await fn(db);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    },
    close: () => client.end(),
  };
  return db;
}
const tmpDir = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
const quiet = () => {};

before(async () => {
  if (!url) return;
  pg = require('pg');
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const files = fs
    .readFileSync(path.join(root, 'prisma/legacy-order.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
  for (const f of files) await admin.query(fs.readFileSync(path.join(root, f), 'utf8'));
});
after(async () => admin?.end());

const { runMigrations } = require('../../src/services/migrations');
const { checkSchema } = require('../../src/services/schemaCheck');

test('production history + prisma/auto migrations give exactly the schema the code expects', opts, async () => {
  const db = await connect();
  try {
    await runMigrations(db, { log: quiet });
    const again = await runMigrations(db, { log: quiet });
    assert.deepEqual(again.applied, [], 'a second start applies nothing');
    await checkSchema(db);
  } finally {
    await db.close();
  }
});

test('two instances starting together apply a migration exactly once', opts, async () => {
  const dir = tmpDir({ '209901010000_concurrent.sql': 'CREATE TABLE "_it_concurrent" ("id" SERIAL PRIMARY KEY);\n' });
  const [a, b] = await Promise.all([connect(), connect()]);
  try {
    const results = await Promise.all([runMigrations(a, { dir, log: quiet }), runMigrations(b, { dir, log: quiet })]);
    assert.equal(results.flatMap((r) => r.applied).length, 1);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('a failing migration is rolled back entirely and not recorded', opts, async () => {
  const dir = tmpDir({
    '209901020000_broken.sql':
      'CREATE TABLE "_it_partial" ("id" INT);\nALTER TABLE "_it_missing" ADD COLUMN "x" INT;\n',
  });
  const db = await connect();
  try {
    await assert.rejects(runMigrations(db, { dir, log: quiet }));
    const t = await admin.query(`SELECT to_regclass('"_it_partial"') AS t`);
    assert.equal(t.rows[0].t, null, 'first statement rolled back');
    const r = await admin.query(`SELECT 1 FROM "_app_migrations" WHERE name = '209901020000_broken.sql'`);
    assert.equal(r.rowCount, 0);
  } finally {
    await db.close();
  }
});

test('destructive changes need an explicit marker and never touch columns the code uses', opts, async () => {
  const db = await connect();
  try {
    const unmarked = tmpDir({ '209901030000_drop.sql': 'ALTER TABLE "Match" DROP COLUMN IF EXISTS "syncIssue";\n' });
    await assert.rejects(runMigrations(db, { dir: unmarked, log: quiet }), /__destructif/);
    const used = tmpDir({ '209901030000_drop__destructif.sql': 'ALTER TABLE "Match" DROP COLUMN "syncIssue";\n' });
    await assert.rejects(runMigrations(db, { dir: used, log: quiet }), /encore utilisée/);
    const cols = await admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'Match' AND column_name = 'syncIssue'`,
    );
    assert.equal(cols.rowCount, 1, 'nothing dropped');
  } finally {
    await db.close();
  }
});
