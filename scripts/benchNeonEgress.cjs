// Exécution explicite uniquement : pas de déclenchement par npm test. Base de test vérifiée,
// transaction READ ONLY, aucun contenu nominatif exporté dans le rapport.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const host = new URL(config.url).hostname;
assert.equal(config.branchId, 'br-patient-tooth-b1ke6ifq');
assert.equal(host, `${config.expectedEndpoint}-pooler.c-5.eu-central-1.aws.neon.tech`);
assert.equal(config.expectedEndpoint, 'ep-summer-leaf-b1rznai6');
const { PrismaClient } = require('@prisma/client');
const { latestControls } = require('../src/services/syncHealth');
const db = new PrismaClient({ datasources: { db: { url: config.url } }, log: [{ emit: 'event', level: 'query' }] });
const queries = [];
db.$on('query', (e) => queries.push(e.query));
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
const actions = ['Contrôle FTL terminé', 'Configuration FTL validée'];
async function fingerprint(tx) {
  const out = {};
  for (const table of [
    'Prediction',
    'PoolPrediction',
    'PodiumPrediction',
    'PointAdjustment',
    'Match',
    'Pool',
    'PoolFencer',
  ]) {
    const [r] = await tx.$queryRawUnsafe(
      `SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) AS digest FROM "${table}" t`,
    );
    out[table] = r;
  }
  return out;
}
(async () => {
  let report;
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const before = await fingerprint(tx);
      const groups = await tx.auditLog.groupBy({
        by: ['targetId'],
        where: { action: { in: actions }, targetType: 'Competition' },
      });
      const ids = groups.map((x) => x.targetId);
      const where = { action: { in: actions }, targetType: 'Competition', targetId: { in: ids } };
      const start = queries.length;
      const legacy = await tx.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        distinct: ['targetId', 'action'],
        select: { targetId: true, action: true, after: true },
      });
      const legacySQL = queries.slice(start);
      let transferred = 0,
        groupBytes = 0,
        readRows = 0;
      const measuring = {
        auditLog: {
          groupBy: async (q) => {
            const rows = await tx.auditLog.groupBy(q);
            groupBytes += bytes(rows);
            return rows;
          },
          findMany: async (q) => {
            const rows = await tx.auditLog.findMany(q);
            transferred += bytes(rows);
            readRows += rows.length;
            return rows;
          },
        },
      };
      const optimized = await latestControls(measuring, ids);
      assert.deepEqual(optimized, legacy);
      // Mesure serveur de la représentation JSON des lignes correspondant au SELECT historique,
      // sans en rapatrier le contenu une seconde fois. Proxy SQL réel capturé ci-dessus.
      const [oldSize] = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS rows, sum(octet_length(json_build_object('targetId',"targetId",'action',action,'after',"after")::text))::bigint::text AS bytes FROM "AuditLog" WHERE "targetType"='Competition' AND action IN ('Contrôle FTL terminé','Configuration FTL validée')`,
      );
      const after = await fingerprint(tx);
      assert.deepEqual(after, before);
      report = {
        branchId: config.branchId,
        checkedAt: new Date().toISOString(),
        competitionGroups: ids.length,
        legacyRowsRead: oldSize.rows,
        legacyProjectedJSONBytes: Number(oldSize.bytes),
        legacyHasSQLDistinct: /\bDISTINCT\b/i.test(legacySQL.join('\n')),
        legacyQueryCount: legacySQL.length,
        optimizedRowsRead: readRows,
        optimizedResultJSONBytes: transferred,
        optimizedGroupJSONBytes: groupBytes,
        optimizedTotalJSONBytes: transferred + groupBytes,
        identicalResults: true,
        predictionsPointsAndAttachmentsUnchanged: true,
        fingerprints: before,
        legacySQL,
      };
      report.projectedJSONReductionPercent =
        100 * (1 - report.optimizedTotalJSONBytes / report.legacyProjectedJSONBytes);
    },
    { timeout: 120000, maxWait: 10000 },
  );
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, fingerprints: undefined, legacySQL: undefined }, null, 2));
})()
  .catch((e) => {
    console.error(
      e.name,
      e.code || '',
      String(e.message)
        .replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]')
        .slice(0, 400),
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
