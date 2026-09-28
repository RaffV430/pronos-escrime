const { failure } = require('./ftlClient');
const { calculateMatchPoints } = require('./matchPoints');
const defaults = {
  newMatches: true,
  reminders: true,
  roundResults: false,
  quietEnabled: false,
  quietStart: '22:00',
  quietEnd: '08:00',
  timezone: 'Europe/Paris',
};
function preferences(input = {}) {
  const p = { ...defaults, ...input };
  for (const k of ['newMatches', 'reminders', 'roundResults', 'quietEnabled'])
    if (typeof p[k] !== 'boolean') throw failure('Préférence de notification invalide.', 400);
  for (const k of ['quietStart', 'quietEnd'])
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[k])) throw failure('Horaire silencieux invalide.', 400);
  try {
    if (typeof p.timezone !== 'string' || p.timezone.length > 80) throw Error();
    new Intl.DateTimeFormat('fr', { timeZone: p.timezone }).format();
  } catch {
    throw failure('Fuseau horaire invalide.', 400);
  }
  if (p.quietEnabled && p.quietStart === p.quietEnd)
    throw failure('Choisissez deux horaires silencieux différents.', 400);
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, p[k]]));
}
function isQuiet(input, now = new Date()) {
  const p = preferences(input || {});
  if (!p.quietEnabled) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: p.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const t = parts.find((x) => x.type === 'hour').value + ':' + parts.find((x) => x.type === 'minute').value;
  return p.quietStart < p.quietEnd ? t >= p.quietStart && t < p.quietEnd : t >= p.quietStart || t < p.quietEnd;
}
function roundSummaries(matches, rounds) {
  return rounds
    .map((r) => {
      const group = matches.filter((m) => m.round === r.round && m.resultType !== 'CANCELLED');
      const completed =
        group.length === r.expectedMatchCount && group.length > 0 && group.every((m) => m.isFinished && !m.syncIssue);
      const scored = group.filter((m) => m.isFinished && !m.syncIssue && m.predictions?.length);
      let points = 0,
        exact = 0,
        winners = 0;
      for (const m of scored) {
        const p = m.predictions[0];
        const score = calculateMatchPoints(
          p.predictedScore1,
          p.predictedScore2,
          m.score1,
          m.score2,
          m.winner,
          m.resultType,
        );
        points += (p.pointsEarned || 0) + (p.bonusPoints || 0);
        winners += score > 0 ? 1 : 0;
        exact += score === 4 ? 1 : 0;
      }
      const stamps = group
        .map((m) => m.resultRegisteredAt && new Date(m.resultRegisteredAt).getTime())
        .filter(Number.isFinite);
      return {
        round: r.round,
        completed,
        total: r.expectedMatchCount,
        finished: group.filter((m) => m.isFinished).length,
        saved: group.filter((m) => m.predictions?.length).length,
        played: scored.length,
        points,
        exact,
        winners,
        completedAt: completed && stamps.length === group.length ? new Date(Math.max(...stamps)).toISOString() : null,
      };
    })
    .sort((a, b) => (Number(b.round.slice(1)) || 0) - (Number(a.round.slice(1)) || 0));
}
function freshness(state, now = Date.now()) {
  if (!state) return { state: 'UNKNOWN', checkedAt: null, nextAt: null };
  const late = state.nextAutomaticAt && now > new Date(state.nextAutomaticAt).getTime() + 180000;
  return {
    state:
      state.status === 'COMPLETE'
        ? 'COMPLETE'
        : state.status === 'RUNNING'
          ? state.leaseUntil && new Date(state.leaseUntil).getTime() > now
            ? 'RUNNING'
            : 'DELAYED'
          : ['ERROR', 'ATTENTION'].includes(state.status) || late
            ? 'DELAYED'
            : state.status === 'SCHEDULED'
              ? 'SCHEDULED'
              : state.lastFinishedAt
                ? 'CURRENT'
                : 'UNKNOWN',
    checkedAt: state.lastFinishedAt,
    nextAt: state.nextAutomaticAt,
  };
}
module.exports = { defaults, preferences, isQuiet, roundSummaries, freshness };
