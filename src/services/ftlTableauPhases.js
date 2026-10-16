const { failure } = require('./ftlClient');
const { validateManifest } = require('./roundManifest');
function preliminary(observation) {
  validateManifest(observation.rounds, { terminal: 'T64' });
  if (observation.rounds.some((r) => Number(r.round.slice(1)) < 64)) throw failure('Tableau préliminaire inattendu.');
  const prefix = 'J1:';
  return {
    ...observation,
    matches: observation.matches.map((m) => ({
      ...m,
      round: prefix + m.round,
      sourceKey: prefix + m.sourceKey,
      sourceUrl: observation.sourceUrl,
    })),
    rounds: observation.rounds.map((r) => ({
      ...r,
      round: prefix + r.round,
      previousRound: r.previousRound ? prefix + r.previousRound : null,
      sourceUrl: observation.sourceUrl,
    })),
    byes: (observation.byes || []).map((b) => ({ ...b, round: prefix + b.round })),
    issues: (observation.issues || []).map((i) => ({
      ...i,
      round: prefix + i.round,
      sourceKey: i.sourceKey ? prefix + i.sourceKey : i.sourceKey,
    })),
    officialPodium: null,
    resultsSourceUrl: null,
  };
}
function combine(observations) {
  const main = observations.filter((o) => o.rounds.some((r) => r.round === 'T2'));
  const prelim = observations.filter((o) => o.rounds.some((r) => r.round === 'J1:T64'));
  if (main.length > 1 || prelim.length > 1) throw failure('Phases officielles ambiguës.');
  const first = main[0] || observations[0];
  return {
    ...first,
    sourceUrls: observations.map((o) => o.sourceUrl),
    matches: observations.flatMap((o) => o.matches.map((m) => ({ ...m, sourceUrl: o.sourceUrl }))),
    rounds: observations.flatMap((o) => o.rounds.map((r) => ({ ...r, sourceUrl: o.sourceUrl }))),
    byes: observations.flatMap((o) => o.byes || []),
    issues: observations.flatMap((o) => o.issues || []),
    warnings: observations.flatMap((o) => o.warnings || []),
    officialPodium: main[0]?.officialPodium || null,
    resultsSourceUrl: main[0]?.resultsSourceUrl || null,
  };
}
function enabled(config) {
  return config?.scheduleSessions?.length > 1 || config?.preliminaryUntil === 'T64';
}
module.exports = { preliminary, combine, enabled };
