// Nombre de touches d'une rencontre d'élimination directe selon l'épreuve.
// Épreuve vétérans (mention « Vet » / « Vétérans » dans son nom) : 10 touches (règlement FIE vétérans).
// Un tireur vétéran engagé dans une épreuve seniors tire, lui, en 15 touches : seule l'épreuve compte.
const VETERAN = /\bv[ée]t(?:[ée]rans?)?\b/i;
const isVeteranEvent = (competition) => VETERAN.test(String(competition?.name || ''));
function boutMax(competition) {
  if (competition?.podiumFormat === 'TEAM') return 45;
  return isVeteranEvent(competition) ? 10 : 15;
}
module.exports = { boutMax, isVeteranEvent };
