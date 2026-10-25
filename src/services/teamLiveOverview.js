const { liveStripIdentity } = require('./liveStripIdentity');
// Vue de consultation uniquement : aucune création de Match ni attribution de points.
const { norm } = require('./ftlParser');
const { countryFor } = require('./matchCountries');
const fold = (value) =>
  norm(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const genderOf = (name) =>
  /\b(women|female|dames|femmes)\b/i.test(name) ? 'women' : /\b(men|male|hommes)\b/i.test(name) ? 'men' : 'unknown';
function teamForSide(competition, side) {
  const roster = Array.isArray(competition.podiumRoster) ? competition.podiumRoster : [];
  const country = countryFor([{ name: side.name, country: side.country }], side.name);
  const teams = roster.filter(
    (team) =>
      (team.members || []).some((name) => fold(name) === fold(side.name)) &&
      (!country || countryFor([team], team.name) === country),
  );
  return teams.length === 1 ? teams[0] : null;
}
function teamLiveRows(competitions, matches, states, now = Date.now(), freshMs = 180000) {
  const rows = [];
  for (const state of states) {
    if (now - state.at > freshMs || !state.left.name || !state.right.name) continue;
    const assignments = competitions
      .filter((c) => c.podiumFormat === 'TEAM')
      .flatMap((c) => {
        const left = teamForSide(c, state.left),
          right = teamForSide(c, state.right);
        return left && right && left.id !== right.id ? [{ c, left, right }] : [];
      });
    if (assignments.length !== 1) continue;
    const { c, left, right } = assignments[0];
    const related = matches.filter(
      (m) =>
        m.competitionId === c.id &&
        liveStripIdentity(m.strip) === liveStripIdentity(state.strip) &&
        ((fold(m.player1) === fold(left.name) && fold(m.player2) === fold(right.name)) ||
          (fold(m.player1) === fold(right.name) && fold(m.player2) === fold(left.name))),
    );
    // Une association douteuse reste masquée ; un résultat officiel prime sur une piste restée affichée.
    if (related.length > 1 || related[0]?.isFinished) continue;
    const match = related[0];
    rows.push({
      matchId: match
        ? `team-live:match:${match.id}`
        : `team-live:${c.id}:${[String(left.id), String(right.id)].sort().join(':')}:${state.strip}`,
      officialMatchId: match?.id || null,
      competitionId: c.id,
      competitionName: c.name,
      gender: genderOf(c.name),
      tournamentId: c.tournamentId,
      round: match?.round || null,
      player1: left.name,
      player2: right.name,
      player1Country: countryFor([left], left.name),
      player2Country: countryFor([right], right.name),
      fencer1: state.left,
      fencer2: state.right,
      score1: state.left.score,
      score2: state.right.score,
      strip: state.strip,
      clock: state.clock,
      period: state.period,
      finished: false,
      updatedAt: new Date(state.at).toISOString(),
    });
  }
  return rows;
}
module.exports = { teamLiveRows, teamForSide, genderOf };
