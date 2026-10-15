const { liveDetectedAt } = require('./liveDetection');
const GRACE_MS = 10 * 60 * 1000;
const time = (value) => (value ? new Date(value).getTime() : NaN);
function closesAt(match) {
  const detected = liveDetectedAt(match);
  if (detected) return new Date(detected).toISOString();
  if (match.manualUnlockUntil) return new Date(match.manualUnlockUntil).toISOString();
  if (match.timingUnverified || match.awaitingPreviousRound) return null;
  const start = time(match.startsAt),
    completed = time(match.previousRoundCompletedAt);
  let deadline = Math.max(
    Number.isFinite(start) ? start : -Infinity,
    Number.isFinite(completed) ? completed + GRACE_MS : -Infinity,
  );
  // Un premier résultat du tour publié avant cette échéance : les assauts ont commencé, le tour ferme.
  const begun = time(match.roundStartedAt);
  if (Number.isFinite(begun) && (!Number.isFinite(deadline) || begun < deadline)) deadline = begun;
  return Number.isFinite(deadline) ? new Date(deadline).toISOString() : null;
}
function matchClosed(match, now = Date.now()) {
  if (liveDetectedAt(match) || match.isFinished || match.syncIssue || match.progressionConfirmedAt) return true;
  // An expired override closes the round even if its original deadline is later.
  if (match.manualUnlockUntil) return now >= time(match.manualUnlockUntil);
  if (match.timingUnverified) return true;
  const deadline = closesAt(match);
  return Boolean(match.isLocked || (deadline && now >= Date.parse(deadline)));
}
function roundContext(matches, rounds) {
  return matches.map((match) => {
    const config = rounds.find((r) => r.competitionId === match.competitionId && r.round === match.round);
    const previous =
      config?.previousRound &&
      rounds.find((r) => r.competitionId === match.competitionId && r.round === config.previousRound);
    const results = previous
      ? matches.filter(
          (m) => m.resultType !== 'CANCELLED' && m.competitionId === match.competitionId && m.round === previous.round,
        )
      : [];
    // Une rencontre mise à part pour vérification (écart avec la source) ne bloque pas le déroulé :
    // le tour suivant se ferme comme prévu, l'écart est traité après.
    const settled = results.filter((m) => !m.syncIssue || Number.isFinite(time(m.progressionConfirmedAt)));
    const complete =
      previous &&
      results.length === previous.expectedMatchCount &&
      settled.every(
        (m) =>
          Number.isFinite(time(m.progressionConfirmedAt)) ||
          (m.isFinished && Number.isFinite(time(m.progressionConfirmedAt || m.resultRegisteredAt))),
      );
    // Premier résultat officiel du même tour : les assauts de ce tour ont commencé.
    const begun = matches
      .filter(
        (m) =>
          m.competitionId === match.competitionId &&
          m.round === match.round &&
          m.resultType !== 'CANCELLED' &&
          m.isFinished &&
          Number.isFinite(time(m.resultRegisteredAt)),
      )
      .map((m) => time(m.resultRegisteredAt));
    return {
      ...match,
      roundStartedAt: begun.length ? new Date(Math.min(...begun)).toISOString() : null,
      manualUnlockUntil: config?.manualUnlockUntil || null,
      timingUnverified: !config,
      awaitingPreviousRound: Boolean(config?.previousRound && !complete),
      previousRoundCompletedAt:
        complete && settled.length
          ? new Date(
              Math.max(...settled.map((m) => time(m.progressionConfirmedAt || m.resultRegisteredAt))),
            ).toISOString()
          : null,
    };
  });
}
function podiumClosed(competition, matches, now = Date.now()) {
  matches = matches.filter((m) => m.resultType !== 'CANCELLED');
  if (competition.podiumResolvedAt || competition.officialPodium?.finalConfirmed) return true;
  if (competition.podiumManualUnlock) return false;
  if (competition.isPodiumLocked) return true;
  const rounds = matches.map((m) => Number(/^T(\d+)$/.exec(m.round || '')?.[1])).filter(Number.isFinite);
  if (!rounds.length) return false;
  const firstRound = `T${Math.max(...rounds)}`;
  return matches.filter((m) => m.round === firstRound).some((m) => matchClosed(m, now));
}
module.exports = { matchClosed, closesAt, podiumClosed, roundContext, GRACE_MS };
