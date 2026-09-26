const DELAY_MS = 30 * 60 * 1000;
function closesAt(match) {
  if (!match.startsAt) return null;
  const time = new Date(match.startsAt).getTime();
  return Number.isFinite(time) ? new Date(time + DELAY_MS).toISOString() : null;
}
function matchClosed(match, now = Date.now()) {
  if (match.isFinished) return true;
  if (match.manualUnlock) return false;
  const deadline = closesAt(match);
  return Boolean(match.isLocked || (deadline && now >= Date.parse(deadline)));
}
function podiumClosed(competition, matches, now = Date.now()) {
  if (competition.podiumManualUnlock) return false;
  if (competition.isPodiumLocked) return true;
  const rounds = matches.map(m => Number(/^T(\d+)$/.exec(m.round || '')?.[1])).filter(Number.isFinite);
  if (!rounds.length) return false;
  const firstRound = `T${Math.max(...rounds)}`;
  return matches.filter(m => m.round === firstRound).some(m => matchClosed(m, now));
}
module.exports = { matchClosed, closesAt, podiumClosed };
