const { fail } = require('./poolRules');
function integer(value, label = 'Valeur') {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} invalide.`);
  return value;
}
function title(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 80)
    fail('Nom requis : 3 à 80 caractères.');
  return value.trim();
}
function challengePoints(pick, match, bonus = 3) {
  if (!match?.isFinished) return 0;
  const winner =
    match.resultType === 'MEDICAL_WITHDRAWAL'
      ? match.winner
      : Number.isInteger(match.score1) && Number.isInteger(match.score2) && match.score1 !== match.score2
        ? match.score1 > match.score2
          ? 1
          : 2
        : null;
  return winner && pick.winner === winner ? bonus : 0;
}
function clubScore(members, rows) {
  return members.length
    ? members.reduce((s, m) => s + (rows.find((r) => r.id === m.userId)?.totalPoints || 0), 0) / members.length
    : 0;
}
module.exports = { integer, title, challengePoints, clubScore };
