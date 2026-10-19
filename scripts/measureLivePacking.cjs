const { measure } = require('./measureLiveBandwidth.cjs');
(async () => {
  const results = [];
  for (const delta of [false, true]) {
    const before = await measure({ delta, gzip: true, transformProxy: true });
    const after = await measure({ delta, gzip: true, transformProxy: true, packedWire: true });
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
          'HTTP localhost avec relais supprimant la compression HTTP ; données synthétiques, aucun déploiement Render',
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
