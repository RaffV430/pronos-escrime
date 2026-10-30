// Presentation only. Keep the raw observations intact for diagnosis and future corrections.
function presentLiveHistory(match, observations = []) {
  let history = observations;
  let historyNotice = null;
  if (
    match.isFinished &&
    !match.pointsPending &&
    match.podiumFormat === 'TEAM' &&
    Number.isInteger(match.score1) &&
    Number.isInteger(match.score2)
  ) {
    for (let i = 1; i < observations.length; i++) {
      const end = observations[i - 1];
      if (
        end.period !== 9 ||
        observations[i].period !== 1 ||
        end.score1 !== match.score1 ||
        end.score2 !== match.score2
      )
        continue;
      const tail = observations.slice(i);
      // Only the evidenced final-relay -> first-relay reset, below the confirmed final score.
      // Real in-bout corrections, uncertain periods and a later return to relay 9 stay untouched.
      if (
        tail.every((e) => e.period === 1 && e.score1 <= match.score1 && e.score2 <= match.score2) &&
        tail.some((e) => e.score1 < match.score1 || e.score2 < match.score2)
      ) {
        history = observations.slice(0, i);
        historyNotice = 'Les observations revenant au premier relais après le score final sont masquées.';
        break;
      }
    }
  }
  const last = history.at(-1);
  if (
    match.isFinished &&
    last &&
    Number.isInteger(match.score1) &&
    Number.isInteger(match.score2) &&
    (last.score1 > match.score1 || last.score2 > match.score2)
  )
    return {
      history: [],
      historyIssue: 'Le déroulé live diffère du résultat officiel ; il est masqué.',
      historyNotice: null,
    };
  return { history, historyIssue: null, historyNotice };
}
module.exports = { presentLiveHistory };
