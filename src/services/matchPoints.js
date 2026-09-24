function calculateMatchPoints(predictedScore1, predictedScore2, score1, score2) {
  const predictedWinner = predictedScore1 > predictedScore2 ? 1 : predictedScore2 > predictedScore1 ? 2 : 0;
  const actualWinner = score1 > score2 ? 1 : score2 > score1 ? 2 : 0;

  if (actualWinner === 0 || predictedWinner !== actualWinner) return 0;
  return predictedScore1 === score1 && predictedScore2 === score2 ? 4 : 1;
}

module.exports = { calculateMatchPoints };
