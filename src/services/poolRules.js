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
// optionalIndicator : pronostic simplifié, les victoires seules suffisent (l'indice ne rapporte alors rien).
function validatePrediction(value, size, { optionalIndicator = false } = {}) {
  const skipped = optionalIndicator && value && (value.indicator === null || value.indicator === undefined);
  if (!value || ![value.wins, value.losses, ...(skipped ? [] : [value.indicator])].every(Number.isInteger)) {
    fail('Victoires, défaites et indice doivent être des entiers.');
  }
  const { wins, losses } = value;
  const indicator = skipped ? null : value.indicator;
  const bouts = size - 1;
  if (wins < 0 || losses < 0 || wins + losses !== bouts) {
    fail(`Victoires + défaites doivent être égales à ${bouts}.`);
  }
  if (skipped) return { wins, losses, indicator };
  // Poules en cinq touches : chaque victoire contribue de +1 à +5,
  // chaque défaite de -5 à -1, y compris les victoires au temps.
  if (indicator < wins - 5 * losses || indicator > 5 * wins - losses) {
    fail(`Indice incompatible avec ce bilan (de ${wins - 5 * losses} à ${5 * wins - losses}).`);
  }
  return { wins, losses, indicator };
}
// Poules suivies sur la source officielle : clôture tireur par tireur au premier résultat publié.
// Une heure officielle vérifiable ferme aussi la poule, dans le fuseau du lieu.
// closesAt suit cette heure lorsqu’elle change, quel que soit le pays.
const START_LOCK = 'START_OR_FIRST_RESULT';
// Tirage provisoire (engarde, avant l'appel) : poule visible mais fermée aux pronostics.
const PROVISIONAL = 'PROVISIONAL';
const followsSource = (pool) => ['FIRST_RESULT', START_LOCK, PROVISIONAL].includes(pool?.lockMode);
// Mode et heure de clôture d'une poule suivie, d'après l'heure de début officielle.
function sourceLock(observedStart, closeAtStart, fallbackClosesAt, provisional = false) {
  if (provisional) return { lockMode: PROVISIONAL, closesAt: new Date(0) };
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
  // Tireur absent, retiré ou exclu : plus de pronostic possible sur lui.
  if (fencer.status) return true;
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
    indicatorCorrect: compared.indicator != null && compared.indicator === fencer.indicator,
    indicatorDifference: compared.indicator == null ? null : compared.indicator - fencer.indicator,
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
  const indicator =
    prediction.indicator == null ? null : prediction.indicator + annulled * (wins * 2 >= bouts ? -5 : 5);
  return { wins, indicator, annulled };
}
function poolPoints(prediction, result, size = null) {
  const adjusted = adjustForAnnulled(prediction, result, size);
  const compared = adjusted || prediction;
  const winDifference = Math.abs(compared.wins - result.wins);
  const winsPoints = winDifference === 0 ? 3 : winDifference === 1 ? 1 : 0;
  // Victoires seules (indice non saisi) : pas de points d'indice.
  if (compared.indicator == null)
    return { winsPoints, indicatorPoints: 0, total: winsPoints, ...(adjusted ? { adjusted } : {}) };
  const indicatorDifference = Math.abs(compared.indicator - result.indicator);
  const indicatorPoints =
    indicatorDifference === 0 ? 5 : indicatorDifference <= 3 ? 3 : indicatorDifference <= 5 ? 1 : 0;
  return { winsPoints, indicatorPoints, total: winsPoints + indicatorPoints, ...(adjusted ? { adjusted } : {}) };
}
// Texte d'un pronostic de poule : « 3 V · indice +4 » ou « 3 V » (victoires seules).
const poolPredictionText = (p) =>
  p ? (p.indicator == null ? `${p.wins} V` : `${p.wins} V · indice ${p.indicator}`) : null;
module.exports = {
  poolPredictionText,
  START_LOCK,
  PROVISIONAL,
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
