// Recalcule les points d'un lot de pronostics en regroupant les écritures.
// Les pronostics identiques (même score, ou même bilan de poule) reçoivent les
// mêmes points : une seule requête updateMany par combinaison distincte, au lieu
// d'une requête par joueur. Avec des centaines de joueurs, cela garde la
// transaction bien en deçà de son délai maximal.
//
// model      : délégué Prisma (tx.prediction, tx.poolPrediction…)
// scope      : filtre commun (ex. { matchId }) — doit couvrir tous les pronostics fournis
// predictions: pronostics déjà lus dans ce périmètre
// keys       : champs qui déterminent les points (ex. ['predictedScore1','predictedScore2'])
// compute    : prediction => points
// Retourne le nombre de pronostics dont les points ont changé.
async function rescore(model, scope, predictions, keys, compute) {
  const groups = new Map();
  for (const prediction of predictions) {
    const key = JSON.stringify(keys.map(k => prediction[k]));
    if (!groups.has(key)) groups.set(key, { values: prediction, points: compute(prediction), changed: 0 });
    const group = groups.get(key);
    if (prediction.pointsEarned !== group.points) group.changed++;
  }
  let changed = 0;
  for (const group of groups.values()) {
    if (!group.changed) continue;
    const where = { ...scope };
    for (const k of keys) where[k] = group.values[k];
    await model.updateMany({ where, data: { pointsEarned: group.points } });
    changed += group.changed;
  }
  return changed;
}

module.exports = { rescore };
