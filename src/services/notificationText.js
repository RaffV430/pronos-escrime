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
    // Fuseau affiché seulement hors de l'heure de Paris (« UTC+2 » n'aide pas un joueur en France).
    ...(timezone === 'Europe/Paris' ? {} : { timeZoneName: 'shortOffset' }),
  }).format(first);
  return `${new Set(valid).size > 1 ? 'clôtures dès' : 'clôture à'} ${time}${day.format(first) !== day.format(now) ? ` le ${day.format(first)}` : ''}`;
}
// « MARTIN Léa », « MARTIN Léa et DURAND Chloé », « MARTIN Léa et 2 autres tireurs ».
function fencerList(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} et ${list[1]}`;
  return `${list[0]} et ${list.length - 1} autres tireurs`;
}
// fencers : noms des tireurs suivis (mode « uniquement Mes tireurs ») ; le message les nomme.
function matchNotificationText(
  competition,
  round,
  matches,
  timezone,
  kind = 'AVAILABLE',
  now = new Date(),
  fencers = null,
) {
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
  const action = kind === 'REMINDER' ? 'à compléter' : 'à pronostiquer';
  if (fencers?.length) {
    const mine = matches.flatMap((m) => [m.player1, m.player2].filter((n) => fencers.includes(n)));
    const body =
      matches.length === 1
        ? `${matches[0].player1} – ${matches[0].player2} · ${roundLabel(round)} ${action}`
        : `${roundLabel(round)} · ${fencerList(mine)} · ${matches.length} matchs ${action}`;
    return { timing, title: competition.name, body: `${body} · ${closingText(matches, timezone, now)}` };
  }
  return {
    timing,
    title: competition.name,
    body: `${roundLabel(round)} · ${matches.length} match${matches.length > 1 ? 's' : ''} ${action} · ${closingText(matches, timezone, now)}`,
  };
}
const ROUND_NAMES = { T2: 'finale', T4: 'demi-finales', T8: 'quarts de finale' };
const roundIn = (round) => ROUND_NAMES[round] || roundLabel(round);
const nextRound = (round) => {
  const n = Number(/^T(\d+)$/.exec(round || '')?.[1]);
  return n > 2 ? `T${n / 2}` : null;
};
// Résultat d'un match d'un tireur suivi : « ✅ MARTIN Léa passe en T16 (15–11 contre DURAND Chloé) ».
function fencerResultText(competition, m, fencers) {
  const winner = m.winner === 1 || (m.winner == null && m.score1 > m.score2) ? 1 : 2;
  const [w, l] = winner === 1 ? [m.player1, m.player2] : [m.player2, m.player1];
  const score =
    m.resultType === 'MEDICAL_WITHDRAWAL'
      ? `abandon de ${l}`
      : `${Math.max(m.score1, m.score2)}–${Math.min(m.score1, m.score2)}`;
  const versus = m.resultType === 'MEDICAL_WITHDRAWAL' ? `(${score})` : `(${score} contre ${l})`;
  const mineWon = fencers.includes(w),
    mineLost = fencers.includes(l);
  let body;
  if (mineWon && m.round === 'T2') body = `🏆 ${w} remporte l’épreuve (${score} en finale contre ${l})`;
  else if (mineWon && m.round === 'Bronze') body = `🥉 ${w} prend le bronze ${versus}`;
  else if (mineWon && nextRound(m.round)) body = `✅ ${w} passe en ${roundIn(nextRound(m.round))} ${versus}`;
  else if (mineWon) body = `✅ ${w} gagne ${versus}`;
  else if (mineLost)
    body =
      m.round === 'T2'
        ? `🥈 ${l} termine 2e (${score} en finale contre ${w})`
        : `${l} s’arrête en ${roundIn(m.round)} (${score} contre ${w})`;
  return { title: competition.name, body };
}
// Bilan de poule d'un tireur suivi : « Poule 4 · MARTIN Léa : 5 V – 1 D, indice +14, 1re/7 ».
function fencerPoolText(competition, pool, fencer) {
  const ranked = [...pool.fencers]
    .filter((f) => Number.isInteger(f.wins))
    .sort((a, b) => b.wins - a.wins || (b.indicator ?? 0) - (a.indicator ?? 0));
  const place = ranked.findIndex((f) => f.id === fencer.id) + 1;
  const indicator = fencer.indicator > 0 ? `+${fencer.indicator}` : String(fencer.indicator);
  return {
    title: competition.name,
    body: `${pool.name} · ${fencer.name} : ${fencer.wins} V – ${fencer.losses} D, indice ${indicator}${place ? `, ${place}${place === 1 ? 're' : 'e'}/${pool.fencers.length}` : ''}`,
  };
}
module.exports = { roundLabel, closingText, matchNotificationText, fencerList, fencerResultText, fencerPoolText };
