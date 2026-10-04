function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function id(value) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2147483647) fail('Identifiant invalide.');
  return parsed;
}
function validatePrediction(value, size) {
  if (!value || ![value.wins, value.losses, value.indicator].every(Number.isInteger)) {
    fail('Victoires, défaites et indice doivent être des entiers.');
  }
  const { wins, losses, indicator } = value;
  const bouts = size - 1;
  if (wins < 0 || losses < 0 || wins + losses !== bouts) {
    fail(`Victoires + défaites doivent être égales à ${bouts}.`);
  }
  // Poules en cinq touches : chaque victoire contribue de +1 à +5,
  // chaque défaite de -5 à -1, y compris les victoires au temps.
  if (indicator < wins - 5 * losses || indicator > 5 * wins - losses) {
    fail(`Indice incompatible avec ce bilan (de ${wins - 5 * losses} à ${5 * wins - losses}).`);
  }
  return { wins, losses, indicator };
}
// Poules suivies sur la source officielle : clôture tireur par tireur au premier résultat publié.
// Épreuves en France : la poule se ferme aussi à son heure de début annoncée (engarde ne publie une
// poule qu'une fois terminée) ; closesAt suit alors l'heure annoncée, y compris quand elle change.
const START_LOCK = 'START_OR_FIRST_RESULT';
const followsSource = (pool) => pool?.lockMode === 'FIRST_RESULT' || pool?.lockMode === START_LOCK;
// Mode et heure de clôture d'une poule suivie, d'après l'heure de début officielle.
function sourceLock(observedStart, closeAtStart, fallbackClosesAt) {
  return closeAtStart && observedStart
    ? { lockMode: START_LOCK, closesAt: new Date(observedStart) }
    : { lockMode: 'FIRST_RESULT', closesAt: fallbackClosesAt };
}
function closed(pool, now = new Date()) {
  return Boolean(pool.isLocked || pool.isFinal || (pool.lockMode !== 'FIRST_RESULT' && new Date(pool.closesAt) <= now));
}
// Tolérance entre deux lectures FencingTimeLive : le suivi repasse toutes les 2 minutes
// pendant l'épreuve (plus la durée du contrôle), 5 minutes laissent une marge sans bloquer.
const SOURCE_WINDOW = 300000;
function sourceUnavailable(pool, now = new Date(), start = null) {
  if (!followsSource(pool)) return false;
  // Avant le jour de l'épreuve, aucun résultat ne peut exister : la saisie reste ouverte.
  if (start && now.getTime() < start) return false;
  return !pool.sourceCheckedAt || now - new Date(pool.sourceCheckedAt) > SOURCE_WINDOW;
}
function fencerClosed(pool, fencer, now = new Date(), start = null) {
  return closed(pool, now) || Boolean(fencer.firstResultAt) || sourceUnavailable(pool, now, start);
}
function validateSource(sourceUrl, sourcePoolNumber) {
  if (typeof sourceUrl !== 'string') fail('Lien FencingTimeLive requis.');
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    fail('Lien FencingTimeLive invalide.');
  }
  if (
    url.origin !== 'https://www.fencingtimelive.com' ||
    url.username ||
    url.password ||
    !/^\/pools\/scores\/[A-Fa-f0-9]{32}\/[A-Fa-f0-9]{32}\/?$/.test(url.pathname)
  ) {
    fail('Utilisez le lien officiel FencingTimeLive des résultats de poules.');
  }
  if (!Number.isInteger(sourcePoolNumber) || sourcePoolNumber < 1 || sourcePoolNumber > 1000)
    fail('Numéro de poule FencingTimeLive invalide.');
  return { sourceUrl: url.origin + url.pathname.replace(/\/$/, ''), sourcePoolNumber };
}
function comparison(prediction, fencer, final, size = null) {
  if (!final || !prediction) return null;
  const points = poolPoints(prediction, fencer, size);
  const compared = points.adjusted || prediction;
  return {
    points,
    winsCorrect: compared.wins === fencer.wins,
    lossesCorrect: prediction.losses === fencer.losses,
    indicatorCorrect: compared.indicator === fencer.indicator,
    indicatorDifference: compared.indicator - fencer.indicator,
  };
}
function validateResults(rows, fencers) {
  if (!Array.isArray(rows) || rows.length !== fencers.length) fail('Un résultat est requis pour chaque tireur.');
  const expected = new Set(fencers.map((f) => f.id));
  const seen = new Set();
  const results = rows.map((row) => {
    const fencerId = id(row?.fencerId);
    if (!expected.has(fencerId) || seen.has(fencerId)) fail('Tireur inconnu ou résultat en double.');
    seen.add(fencerId);
    return { fencerId, ...validatePrediction(row, fencers.length) };
  });
  const bouts = (fencers.length * (fencers.length - 1)) / 2;
  if (results.reduce((s, r) => s + r.wins, 0) !== bouts || results.reduce((s, r) => s + r.indicator, 0) !== 0) {
    fail('Bilan de poule incohérent : une victoire par match et une somme des indices égale à zéro sont requises.');
  }
  // A sorted tournament score sequence must satisfy Landau's inequalities.
  const wins = results.map((r) => r.wins).sort((a, b) => a - b);
  let total = 0;
  for (let k = 1; k <= wins.length; k++) {
    total += wins[k - 1];
    if (total < (k * (k - 1)) / 2) fail('Cette répartition des victoires est impossible dans une poule.');
  }
  return results;
}
// Matchs annulés (absent, retrait médical) : le tireur a tiré moins de matchs que prévu au pronostic.
// Règle : victoires plafonnées au nombre de matchs tirés ; pour chaque match annulé, l'indice
// pronostiqué perd 5 si le bilan pronostiqué est d'au moins la moitié des matchs tirés
// (match annulé supposé gagné 5-0), sinon il gagne 5 (match supposé perdu 0-5).
function adjustForAnnulled(prediction, result, size) {
  if (!Number.isInteger(size) || !Number.isInteger(result?.wins) || !Number.isInteger(result?.losses)) return null;
  const bouts = result.wins + result.losses,
    annulled = size - 1 - bouts;
  if (annulled <= 0 || bouts <= 0) return null;
  const wins = Math.min(prediction.wins, bouts);
  const indicator = prediction.indicator + annulled * (wins * 2 >= bouts ? -5 : 5);
  return { wins, indicator, annulled };
}
function poolPoints(prediction, result, size = null) {
  const adjusted = adjustForAnnulled(prediction, result, size);
  const compared = adjusted || prediction;
  const winDifference = Math.abs(compared.wins - result.wins);
  const indicatorDifference = Math.abs(compared.indicator - result.indicator);
  const winsPoints = winDifference === 0 ? 3 : winDifference === 1 ? 1 : 0;
  const indicatorPoints =
    indicatorDifference === 0 ? 5 : indicatorDifference <= 3 ? 3 : indicatorDifference <= 5 ? 1 : 0;
  return { winsPoints, indicatorPoints, total: winsPoints + indicatorPoints, ...(adjusted ? { adjusted } : {}) };
}
module.exports = {
  START_LOCK,
  followsSource,
  sourceLock,
  poolPoints,
  adjustForAnnulled,
  fail,
  id,
  validatePrediction,
  closed,
  fencerClosed,
  sourceUnavailable,
  validateSource,
  comparison,
  validateResults,
};
