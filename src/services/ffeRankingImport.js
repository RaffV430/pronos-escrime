const { key, lock } = require('./accountClubs');
const affiliations = require('./fencerAffiliations');
const batch = require('../../prisma/data/ffe-rankings-2026-10-09.json');
const marker = 'FFE_RANKINGS_20261009';

async function catalog(db, clubs) {
  return db.$transaction(
    async (tx) => {
      await lock(tx);
      const result = { created: 0, linked: 0, unresolved: [] };
      for (const row of clubs) {
        if (!/^[0-9A-Z]{8}$/.test(row.code) || !key(row.name)) throw new Error('Club fédéral invalide.');
        let club = await tx.club.findUnique({ where: { federationCode: row.code } });
        if (club) continue;
        const known = await tx.club.findMany();
        const matches = known.filter(
          (c) => c.nameKey === key(row.name) || (c.shortName && key(c.shortName) === key(row.name)),
        );
        if (matches.length > 1 || matches.some((c) => c.federationCode && c.federationCode !== row.code)) {
          result.unresolved.push(row);
          continue;
        }
        if (matches.length === 1) {
          await tx.club.update({ where: { id: matches[0].id }, data: { federationCode: row.code } });
          result.linked++;
        } else {
          await tx.club.create({
            data: {
              name: row.name,
              nameKey: key(row.name),
              federationCode: row.code,
              status: 'LISTED',
              source: 'FFE_RANKING_2026_2027',
            },
          });
          result.created++;
        }
      }
      return result;
    },
    { timeout: 60000 },
  );
}

// Import rejouable : les références de compétition, favoris et pronostics ne sont jamais réécrites.
async function run(db) {
  if (await db.auditLog.findFirst({ where: { action: marker } })) return { alreadyApplied: true };
  const clubs = await catalog(db, batch.clubs);
  const fencers = await affiliations.federationImport(db, batch.affiliations, 0);
  const result = { clubs, fencers: { applied: fencers.applied.length, unresolved: fencers.unresolved } };
  await db.auditLog.create({
    data: { actorId: 0, action: marker, targetType: 'FencerAffiliation', targetId: 0, after: result },
  });
  return result;
}
module.exports = { catalog, run };
