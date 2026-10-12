const { createHash } = require('node:crypto');
const A = require('./fencerAffiliations');
const marker = 'FFE_CATALOG_20261009';
const hash = (s) => createHash('sha256').update(s).digest('hex');
async function importRows(db, rows) {
  const counts = new Map();
  for (const r of rows) {
    if (
      !/^[a-f0-9]{64}$/.test(r.federationKey) ||
      !r.name ||
      !/^[A-Z]{3}$/.test(r.country) ||
      !Number.isInteger(r.birthYear) ||
      r.birthYear < 1900 ||
      r.birthYear > 2026
    )
      throw Error('Fiche fédérale invalide.');
    A.source(r.sourceUrl);
    const k = `${A.key(r.name)}:${r.country}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let imported = 0;
  for (let offset = 0; offset < rows.length; offset += 50) {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(72610409)::text`;
        for (const row of rows.slice(offset, offset + 50)) {
          const nameKey = A.key(row.name);
          let profile = await tx.fencerAffiliation.findUnique({ where: { federationKey: row.federationKey } });
          if (!profile && counts.get(`${nameKey}:${row.country}`) === 1) {
            const candidates = await tx.fencerAffiliation.findMany({
              where: { nameKey, country: row.country, federationVerified: true, federationKey: null },
            });
            if (candidates.length === 1) profile = candidates[0];
          }
          if (profile)
            profile = await tx.fencerAffiliation.update({
              where: { id: profile.id },
              data: { federationKey: row.federationKey, birthYear: row.birthYear, federationVerified: true },
            });
          else
            profile = await tx.fencerAffiliation.create({
              data: {
                identityKey: hash(`ffe-catalog:${row.federationKey}`),
                federationKey: row.federationKey,
                name: row.name,
                nameKey,
                country: row.country,
                birthYear: row.birthYear,
                federationVerified: true,
              },
            });
          await A.observe(tx, profile, row);
          imported++;
        }
      },
      { timeout: 60000 },
    );
  }
  return { imported };
}
async function run(db, records) {
  if (await db.auditLog.findFirst({ where: { action: marker } })) return { alreadyApplied: true };
  const result = await importRows(db, records);
  await db.auditLog.create({
    data: { actorId: 0, action: marker, targetType: 'FencerAffiliation', targetId: 0, after: result },
  });
  return result;
}
module.exports = { run, importRows };
