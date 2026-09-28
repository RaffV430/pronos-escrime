const { closesAt } = require('../lib/matchLock');
const roundLabel = (round) => ({ T4: 'Semi-finales', T2: 'Finale' })[round] || round;
function closingText(matches, timezone = 'Europe/Paris', now = new Date()) {
  const stamps = matches.map(closesAt),
    valid = stamps.filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (valid.length !== matches.length || !valid.length) return 'horaire de clôture à confirmer';
  const first = new Date(Math.min(...valid));
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, day: '2-digit', month: '2-digit' });
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).format(first);
  return `${new Set(valid).size > 1 ? 'clôtures dès' : 'clôture à'} ${time}${day.format(first) !== day.format(now) ? ` le ${day.format(first)}` : ''}`;
}
function matchNotificationText(competition, round, matches, timezone, kind = 'AVAILABLE', now = new Date()) {
  const stamps = matches.map(closesAt),
    valid = stamps.filter(Boolean).map(Date.parse).filter(Number.isFinite);
  const timing = {
    version: 1,
    round: roundLabel(round),
    count: matches.length,
    kind,
    closesAt: valid.length === matches.length && valid.length ? new Date(Math.min(...valid)).toISOString() : null,
    staggered: new Set(valid).size > 1,
  };
  return {
    timing,
    title: competition.name,
    body: `${roundLabel(round)} · ${matches.length} match${matches.length > 1 ? 's' : ''} ${kind === 'REMINDER' ? 'à compléter' : 'à pronostiquer'} · ${closingText(matches, timezone, now)}`,
  };
}
module.exports = { roundLabel, closingText, matchNotificationText };
