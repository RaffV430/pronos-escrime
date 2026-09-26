const GRACE_MS = 10 * 60 * 1000;
const time = value => value ? new Date(value).getTime() : NaN;
function closesAt(match) {
  if (match.manualUnlockUntil) return new Date(match.manualUnlockUntil).toISOString();
  if (match.timingUnverified || match.awaitingPreviousRound) return null;
  const start = time(match.startsAt), completed = time(match.previousRoundCompletedAt);
  const deadline = Math.max(Number.isFinite(start) ? start : -Infinity, Number.isFinite(completed) ? completed + GRACE_MS : -Infinity);
  return Number.isFinite(deadline) ? new Date(deadline).toISOString() : null;
}
function matchClosed(match, now = Date.now()) {
  if (match.isFinished) return true;
  // An expired override closes the round even if its original deadline is later.
  if (match.manualUnlockUntil) return now >= time(match.manualUnlockUntil);
  if (match.timingUnverified) return true;
  const deadline = closesAt(match);
  return Boolean(match.isLocked || (deadline && now >= Date.parse(deadline)));
}
function roundContext(matches, rounds) {
  return matches.map(match => {
    const config = rounds.find(r => r.competitionId === match.competitionId && r.round === match.round);
    const previous = config?.previousRound && rounds.find(r => r.competitionId === match.competitionId && r.round === config.previousRound);
    const results = previous ? matches.filter(m => m.competitionId === match.competitionId && m.round === previous.round) : [];
    const complete = previous && results.length === previous.expectedMatchCount && results.every(m => m.isFinished && Number.isFinite(time(m.resultRegisteredAt)));
    return {...match, manualUnlockUntil: config?.manualUnlockUntil || null,
      timingUnverified: !config,
      awaitingPreviousRound: Boolean(config?.previousRound && !complete),
      previousRoundCompletedAt: complete && results.length ? new Date(Math.max(...results.map(m => time(m.resultRegisteredAt)))).toISOString() : null};
  });
}
function podiumClosed(competition, matches, now = Date.now()) {
  if (competition.podiumResolvedAt || competition.officialPodium?.finalConfirmed) return true;
  if (competition.podiumManualUnlock) return false;
  if (competition.isPodiumLocked) return true;
  const rounds = matches.map(m => Number(/^T(\d+)$/.exec(m.round || '')?.[1])).filter(Number.isFinite);
  if (!rounds.length) return false;
  const firstRound = `T${Math.max(...rounds)}`;
  return matches.filter(m => m.round === firstRound).some(m => matchClosed(m, now));
}
module.exports = { matchClosed, closesAt, podiumClosed, roundContext, GRACE_MS };
