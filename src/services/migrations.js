// Migrations automatiques : au démarrage, le serveur applique les scripts SQL de
// prisma/auto/ qui ne l'ont pas encore été, avant de vérifier le schéma.
// Plus besoin d'exécuter du SQL à la main dans Neon.
//
// Règles (voir prisma/auto/README.md) :
// - un fichier = une étape, nommé AAAAMMJJHHMM_description.sql, appliqué dans l'ordre des noms ;
// - une instruction par ligne se terminant par « ; » (pas de blocs DO $$ … $$) ;
// - uniquement des ajouts compatibles avec la version précédente du code, qui tourne
//   encore quelques secondes pendant un déploiement ;
// - une suppression (DROP, TRUNCATE, DELETE, changement de type) exige un nom de fichier
//   contenant « __destructif » et ne peut pas toucher une colonne encore décrite dans
//   schema.prisma.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { expectedColumns } = require('./schemaCheck');

const DIR = path.join(__dirname, '../../prisma/auto');
const SCHEMA = path.join(__dirname, '../../prisma/schema.prisma');
const LOCK = 184730;
const NAME = /^\d{12}_[a-z0-9_-]+\.sql$/;
const DESTRUCTIVE = /\b(DROP|TRUNCATE|DELETE)\b|\bALTER\s+COLUMN\b[^;]*\bTYPE\b|\bRENAME\b/i;

function fail(message) {
  return Object.assign(new Error(message), { migration: true });
}

function statements(sql) {
  if (/\$\$/.test(sql)) throw fail('Les blocs DO $$ … $$ ne sont pas pris en charge : une instruction par ligne.');
  return sql
    .replace(/--.*$/gm, '')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Refuse une migration qui supprimerait ce que le code actuel utilise encore.
function checkSafety(file, stmts, expected) {
  const destructive = stmts.filter((s) => DESTRUCTIVE.test(s));
  if (destructive.length && !file.includes('__destructif'))
    throw fail(`${file} : instruction destructive sans « __destructif » dans le nom du fichier.`);
  for (const s of destructive) {
    const table = /\bTABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(s)?.[1];
    const dropTable = /\bDROP\s+TABLE\b/i.test(s);
    if (dropTable && table && expected[table])
      throw fail(`${file} : la table "${table}" est encore utilisée par le code.`);
    for (const [, column] of s.matchAll(/\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi))
      if (table && expected[table]?.includes(column))
        throw fail(`${file} : la colonne "${table}"."${column}" est encore utilisée par le code.`);
  }
}

function pending(dir = DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      if (!NAME.test(file)) throw fail(`Nom de migration invalide : ${file} (attendu AAAAMMJJHHMM_description.sql).`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { file, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function runMigrations(db, { dir = DIR, schemaPath = SCHEMA, log = console.log } = {}) {
  const files = pending(dir);
  const expected = expectedColumns(fs.readFileSync(schemaPath, 'utf8'));
  for (const f of files) checkSafety(f.file, statements(f.sql), expected);

  await db.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_app_migrations" ("name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  const applied = [];
  for (const f of files) {
    // Verrou + relecture dans la même transaction : deux instances qui démarrent
    // en même temps n'appliquent jamais deux fois la même étape.
    const done = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${LOCK}::bigint)`;
        const rows = await tx.$queryRaw`SELECT "checksum" FROM "_app_migrations" WHERE "name" = ${f.file}`;
        if (rows.length) {
          if (rows[0].checksum !== f.checksum)
            log(`Attention : ${f.file} a été modifié après son application (ignoré).`);
          return false;
        }
        for (const s of statements(f.sql)) await tx.$executeRawUnsafe(s);
        await tx.$executeRaw`INSERT INTO "_app_migrations" ("name", "checksum") VALUES (${f.file}, ${f.checksum})`;
        return true;
      },
      { timeout: 120000, maxWait: 15000 },
    );
    if (done) {
      applied.push(f.file);
      log(`Migration appliquée : ${f.file}`);
    }
  }
  return { applied, total: files.length };
}

module.exports = { runMigrations, statements, checkSafety, pending };
