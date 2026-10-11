// Filtres « pour rire » de « Mes pronostics », calculés sur les matchs terminés avec un score officiel :
// exact (Dans le mille), near (À deux doigts : chaque score à une touche près), oops (score exactement
// inversé), poker (bon vainqueur alors qu'il était le moins bien classé), wire (bon vainqueur d'un match
// gagné d'une touche). L'écart total de touches (scoreGap) sert au « Carton rouge » (plus gros écarts).
function scored(p, m) {
  return Boolean(
    p &&
    m?.isFinished &&
    !m.pointsPending &&
    !['CANCELLED', 'MEDICAL_WITHDRAWAL'].includes(m.resultType) &&
    Number.isInteger(m.score1) &&
    Number.isInteger(m.score2),
  );
}
const side = (a, b) => (a > b ? 1 : b > a ? 2 : 0);

function funTags(p, m) {
  if (!scored(p, m)) return [];
  const [a, b, x, y] = [p.predictedScore1, p.predictedScore2, m.score1, m.score2];
  const picked = side(a, b),
    won = side(x, y) || ([1, 2].includes(m.winner) ? m.winner : 0);
  const tags = [];
  if (a === x && b === y) tags.push('exact');
  else if (Math.abs(a - x) <= 1 && Math.abs(b - y) <= 1) tags.push('near');
  if (a !== b && a === y && b === x) tags.push('oops');
  const right = picked !== 0 && picked === won;
  const [mine, other] = picked === 1 ? [m.seed1, m.seed2] : [m.seed2, m.seed1];
  if (right && Number.isInteger(mine) && Number.isInteger(other) && mine > other) tags.push('poker');
  if (right && Math.abs(x - y) === 1) tags.push('wire');
  return tags;
}

const scoreGap = (p, m) =>
  scored(p, m) ? Math.abs(p.predictedScore1 - m.score1) + Math.abs(p.predictedScore2 - m.score2) : null;

module.exports = { funTags, scoreGap };
