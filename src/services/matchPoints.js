function calculateMatchPoints(predictedScore1, predictedScore2, score1, score2, winner = null, resultType = null) {
  const predictedWinner = predictedScore1 > predictedScore2 ? 1 : predictedScore2 > predictedScore1 ? 2 : 0;
  if (resultType === 'MEDICAL_WITHDRAWAL') return [1, 2].includes(winner) && predictedWinner === winner ? 1 : 0;
  if (score1 == null || score2 == null) return 0;
  const actualWinner = score1 > score2 ? 1 : score2 > score1 ? 2 : 0;

  if (actualWinner === 0 || predictedWinner !== actualWinner) return 0;
  return predictedScore1 === score1 && predictedScore2 === score2 ? 4 : 1;
}

module.exports = { calculateMatchPoints };
