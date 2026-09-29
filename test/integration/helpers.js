// Outils partagés par les tests d'intégration sur un vrai PostgreSQL (TEST_DATABASE_URL).
// La base est reconstruite en rejouant l'historique manuel (prisma/legacy-order.txt),
// identique à la production, puis les migrations automatiques de prisma/auto/.
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
const root = path.join(__dirname, '../..');
const quiet = () => {};

// Adaptateur minimal (client `pg`) exposant l'interface Prisma utilisée par runMigrations/checkSchema.
async function connect(connectionString = url) {
  const pg = require('pg');
  const client = new pg.Client({ connectionString });
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

// Rejoue l'historique manuel de la production, dans l'ordre de prisma/legacy-order.txt.
async function replayLegacyHistory(client) {
  const files = fs
    .readFileSync(path.join(root, 'prisma/legacy-order.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
  for (const f of files) await client.query(fs.readFileSync(path.join(root, f), 'utf8'));
}

// Adresse d'une base dédiée, dérivée de TEST_DATABASE_URL (ex. …/ci → …/ci_critique).
// Chaque fichier de test peut ainsi travailler dans sa propre base : node --test lance
// les fichiers en parallèle, et database.test.js recrée le schéma public de la base principale.
function dedicatedUrl(suffix) {
  const u = new URL(url);
  u.pathname = `/${decodeURIComponent(u.pathname.slice(1))}_${suffix}`;
  return u.toString();
}

// (Re)crée la base dédiée puis y construit le schéma complet (historique + prisma/auto).
async function freshDatabase(suffix) {
  const pg = require('pg');
  const target = dedicatedUrl(suffix);
  const name = decodeURIComponent(new URL(target).pathname.slice(1));
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    await replayLegacyHistory(client);
  } finally {
    await client.end();
  }
  const db = await connect(target);
  try {
    await require('../../src/services/migrations').runMigrations(db, { log: quiet });
  } finally {
    await db.close();
  }
  return target;
}

const tmpDir = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

module.exports = { url, root, quiet, connect, replayLegacyHistory, dedicatedUrl, freshDatabase, tmpDir };
