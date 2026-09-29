// Tests d'intégration sur un vrai PostgreSQL (lancés en CI, ou localement avec
// TEST_DATABASE_URL). La base est reconstruite en rejouant l'historique manuel
// (prisma/legacy-order.txt), identique à la production, puis les migrations
// automatiques de prisma/auto/ sont appliquées et le schéma vérifié.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, quiet, connect, replayLegacyHistory, tmpDir } = require('./helpers');

const opts = { skip: url ? false : 'TEST_DATABASE_URL non défini' };

let admin;
before(async () => {
  if (!url) return;
  admin = new (require('pg').Client)({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await replayLegacyHistory(admin);
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
