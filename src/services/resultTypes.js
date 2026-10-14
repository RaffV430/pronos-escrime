// Victoires sans assaut complet : abandon médical, ou adversaire absent (forfait, « Opponent failed to
// appear » sur FencingTimeLive). Mêmes règles de points : bon vainqueur seulement, aucun point de score.
const WALKOVERS = ['MEDICAL_WITHDRAWAL', 'NO_SHOW'];
const isWalkover = (resultType) => WALKOVERS.includes(resultType);
// « Retrait médical · X » / « Forfait · X » : libellé d'une victoire sans assaut, X étant le vainqueur.
const walkoverLabel = (resultType) => (resultType === 'NO_SHOW' ? 'Forfait' : 'Retrait médical');
module.exports = { WALKOVERS, isWalkover, walkoverLabel };
