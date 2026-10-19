// HTTP local et relais synthétique seulement : aucune connexion à Render/Neon.
const { measure } = require('./measureLiveBandwidth.cjs');
(async () => {
  const results = [];
  for (const delta of [false, true]) {
    const before = await measure({ delta, gzip: true, transformProxy: true });
    const after = await measure({ delta, gzip: true, transformProxy: true, preserveEncoding: true });
    results.push({
      protocol: delta ? 'delta-v1' : 'snapshot',
      before,
      after,
      reductionPercent: Number(((1 - after.bytes / before.bytes) * 100).toFixed(2)),
    });
  }
  console.log(
    JSON.stringify(
      {
        scope:
          'HTTP local, relais de décompression simulé, données synthétiques ; pas une mesure du gain Render après déploiement',
        results,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
