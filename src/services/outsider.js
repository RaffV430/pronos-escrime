// Bonus « outsider » : +1 point pour chaque joueur ayant désigné le bon vainqueur
// quand moins d'un quart des pronostics du match l'avaient choisi.
// Calculé au moment où le résultat est publié (import officiel ou correction
// admin), à partir de tous les pronostics du match, alors clos.
// Pas de bonus en cas de retrait médical ou d'affiche annulée, ni en dessous de
// 8 pronostics (sinon un seul joueur pèserait trop dans la proportion).
const { rescore } = require('./rescore');

const OUTSIDER_MIN_PREDICTIONS = 8;
const OUTSIDER_MAX_SHARE = 0.25;
const OUTSIDER_BONUS = 1;

const predictedWinner = (p) =>
  p.predictedScore1 > p.predictedScore2 ? 1 : p.predictedScore2 > p.predictedScore1 ? 2 : 0;

// { eligible, total, backers, share } pour un résultat donné.
function outsiderRule(predictions, winner, resultType) {
  const valid = predictions.filter((p) => predictedWinner(p) !== 0);
  const total = valid.length;
  const backers = valid.filter((p) => predictedWinner(p) === winner).length;
  const share = total ? backers / total : 0;
  const eligible =
    resultType !== 'MEDICAL_WITHDRAWAL' &&
    resultType !== 'CANCELLED' &&
    [1, 2].includes(winner) &&
    total >= OUTSIDER_MIN_PREDICTIONS &&
    backers > 0 &&
    share < OUTSIDER_MAX_SHARE;
  return { eligible, total, backers, share };
}

// Même règle à partir des tendances agrégées (pour l'affichage).
function crowdIsOutsider(crowd, winner, resultType) {
  if (!crowd || resultType === 'MEDICAL_WITHDRAWAL' || resultType === 'CANCELLED' || ![1, 2].includes(winner))
    return false;
  const backers = Math.round(((winner === 1 ? crowd.player1Pct : crowd.player2Pct) * crowd.total) / 100);
  return crowd.total >= OUTSIDER_MIN_PREDICTIONS && backers > 0 && backers / crowd.total < OUTSIDER_MAX_SHARE;
}

// Écrit bonusPoints pour tous les pronostics du match. Renvoie le nombre de pronostics modifiés.
async function applyOutsiderBonus(model, matchId, predictions, winner, resultType) {
  const rule = outsiderRule(predictions, winner, resultType);
  return rescore(
    model,
    { matchId },
    predictions,
    ['predictedScore1', 'predictedScore2'],
    (p) => (rule.eligible && predictedWinner(p) === winner ? OUTSIDER_BONUS : 0),
    'bonusPoints',
  );
}

module.exports = {
  outsiderRule,
  crowdIsOutsider,
  applyOutsiderBonus,
  predictedWinner,
  OUTSIDER_MIN_PREDICTIONS,
  OUTSIDER_MAX_SHARE,
};
