// Import the complete official round manifest, including rounds with no known pairs yet.
function validateManifest(rounds) {
  if (!Array.isArray(rounds) || !rounds.length || rounds.length > 12)
    throw new Error('Tableau officiel complet requis.');
  const names = new Set(rounds.map((r) => r.round));
  if (names.size !== rounds.length) throw new Error('Tours dupliqués.');
  let roots = 0;
  for (const r of rounds) {
    const n = Number(/^T(\d+)$/.exec(r.round)?.[1]);
    if (!(n >= 2 && n <= 1024 && Number.isInteger(Math.log2(n))) && r.round !== 'Bronze')
      throw new Error('Tour non reconnu.');
    if (
      !Number.isSafeInteger(r.expectedMatchCount) ||
      r.expectedMatchCount < 1 ||
      r.expectedMatchCount > (r.round === 'Bronze' ? 1 : n / 2)
    )
      throw new Error('Nombre de rencontres invalide (exemptions exclues).');
    if (r.previousRound === null) {
      if (r.round === 'Bronze') throw new Error('Prédécesseur requis.');
      roots++;
    } else if (!names.has(r.previousRound) || r.previousRound !== (r.round === 'Bronze' ? 'T4' : `T${n * 2}`))
      throw new Error('Tour précédent manquant ou incohérent.');
  }
  if (roots !== 1 || !names.has('T2')) throw new Error('Le tableau doit relier un premier tour unique à la finale.');
  return rounds.map(({ round, previousRound, expectedMatchCount }) => ({ round, previousRound, expectedMatchCount }));
}
module.exports = { validateManifest };
