// Vérification au démarrage : chaque table et colonne décrite dans
// prisma/schema.prisma doit exister dans la base. Sinon, le serveur refuse de
// démarrer : Render garde alors l'ancienne version en ligne au lieu de publier
// un backend qui planterait à la première requête (ex. SQL de prisma/changes/
// oublié avant le déploiement).
const fs = require('fs');
const path = require('path');

const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);

// Renvoie { Table: [colonnes attendues] } à partir du texte du schéma Prisma.
function expectedColumns(schemaText) {
  const text = schemaText.replace(/\/\/.*$/gm, '');
  const enums = new Set([...text.matchAll(/^\s*enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const tables = {};
  for (const [, model, body] of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const table = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)?.[1] || model;
    const columns = [];
    for (const line of body.split('\n')) {
      const m = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (!m || line.trim().startsWith('@@')) continue;
      const [, field, type] = m;
      if (!SCALARS.has(type) && !enums.has(type)) continue; // champ de relation, sans colonne
      columns.push(/@map\(\s*"([^"]+)"\s*\)/.exec(line)?.[1] || field);
    }
    tables[table] = columns;
  }
  return tables;
}

// rows : [{ table_name, column_name }] lus dans information_schema.
function missingColumns(expected, rows) {
  const present = new Map();
  for (const r of rows) {
    if (!present.has(r.table_name)) present.set(r.table_name, new Set());
    present.get(r.table_name).add(r.column_name);
  }
  const missing = [];
  for (const [table, columns] of Object.entries(expected)) {
    const have = present.get(table);
    if (!have) missing.push(`table "${table}"`);
    else for (const c of columns) if (!have.has(c)) missing.push(`"${table}"."${c}"`);
  }
  return missing;
}

async function checkSchema(db, schemaPath = path.join(__dirname, '../../prisma/schema.prisma')) {
  const expected = expectedColumns(fs.readFileSync(schemaPath, 'utf8'));
  const rows = await db.$queryRaw`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`;
  const missing = missingColumns(expected, rows);
  if (missing.length) {
    const error = new Error(
      `Base de données incomplète pour cette version du backend. Manquant : ${missing.join(', ')}. ` +
        'Appliquez le script correspondant de prisma/changes/ sur Neon, puis redéployez.',
    );
    error.missing = missing;
    throw error;
  }
  return { tables: Object.keys(expected).length };
}

module.exports = { expectedColumns, missingColumns, checkSchema };
