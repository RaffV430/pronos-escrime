// Mesure des octets PostgreSQL reçus sur le flux TLS déchiffré du client pg, pas la facture Neon.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(config.branchId, 'br-patient-tooth-b1ke6ifq');
assert.equal(new URL(config.url).hostname, 'ep-summer-leaf-b1rznai6-pooler.c-5.eu-central-1.aws.neon.tech');
const client = new Client({ connectionString: config.url });
const where = `"targetType" = 'Competition' AND action IN ('Contrôle FTL terminé','Configuration FTL validée')`;
async function measure(sql, params = []) {
  let bytes = 0;
  const onData = (chunk) => {
    bytes += chunk.length;
  };
  client.connection.stream.on('data', onData);
  try {
    const result = await client.query(sql, params);
    return { bytes, rows: result.rows };
  } finally {
    client.connection.stream.removeListener('data', onData);
  }
}
(async () => {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const legacy = await measure(
    `SELECT id,"targetId",action,"after" FROM "AuditLog" WHERE ${where} ORDER BY id DESC OFFSET 0`,
  );
  const groups = await measure(
    `SELECT "targetId",action,max(id) AS max_id FROM "AuditLog" WHERE ${where} GROUP BY "targetId",action`,
  );
  const ids = groups.rows.map((r) => r.max_id);
  const latest = await measure(
    `SELECT id,"targetId",action,"after" FROM "AuditLog" WHERE ${where} AND id=ANY($1::int[]) ORDER BY id DESC`,
    [ids],
  );
  const wanted = new Set(ids);
  assert.deepEqual(
    latest.rows,
    legacy.rows.filter((r) => wanted.has(r.id)),
  );
  await client.query('ROLLBACK');
  const report = {
    checkedAt: new Date().toISOString(),
    branchId: config.branchId,
    legacyRows: legacy.rows.length,
    legacyReceivedPGBytes: legacy.bytes,
    groupReceivedPGBytes: groups.bytes,
    latestRows: latest.rows.length,
    latestReceivedPGBytes: latest.bytes,
    optimizedReceivedPGBytes: groups.bytes + latest.bytes,
    identicalResults: true,
  };
  report.receivedPGReductionPercent = 100 * (1 - report.optimizedReceivedPGBytes / report.legacyReceivedPGBytes);
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
})()
  .catch((e) => {
    console.error(
      e.name,
      e.code || '',
      String(e.message)
        .replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]')
        .slice(0, 250),
    );
    process.exitCode = 1;
  })
  .finally(() => client.end());
