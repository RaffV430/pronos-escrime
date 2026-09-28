// Duel entre deux membres d'une ligue : comparaison match par match sur les
// matchs terminés du tournoi de la ligue. Rien n'est dévoilé avant la fin d'un match.
const total = (p) => (p ? (p.pointsEarned || 0) + (p.bonusPoints || 0) : 0);

function buildDuel(matches, mine, theirs) {
  const byMatch = (list) => new Map(list.map((p) => [p.matchId, p]));
  const a = byMatch(mine),
    b = byMatch(theirs);
  const rows = matches
    .filter((m) => a.has(m.id) || b.has(m.id))
    .map((m) => {
      const pa = a.get(m.id),
        pb = b.get(m.id);
      const me = total(pa),
        them = total(pb);
      return {
        matchId: m.id,
        name: `${m.player1} / ${m.player2}`,
        competition: m.competition?.name || null,
        round: m.round || null,
        result:
          m.resultType === 'MEDICAL_WITHDRAWAL'
            ? `Retrait médical · ${m.winner === 1 ? m.player1 : m.player2}`
            : `${m.score1} – ${m.score2}`,
        me: pa ? { prediction: `${pa.predictedScore1} – ${pa.predictedScore2}`, points: me } : null,
        them: pb ? { prediction: `${pb.predictedScore1} – ${pb.predictedScore2}`, points: them } : null,
        winner: me > them ? 'me' : them > me ? 'them' : 'draw',
      };
    });
  const sum = (key) => rows.reduce((s, r) => s + (r[key]?.points || 0), 0);
  return {
    rows,
    totals: {
      me: sum('me'),
      them: sum('them'),
      won: rows.filter((r) => r.winner === 'me').length,
      lost: rows.filter((r) => r.winner === 'them').length,
      drawn: rows.filter((r) => r.winner === 'draw').length,
    },
  };
}

module.exports = { buildDuel };
