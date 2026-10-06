// Duel entre deux membres d'une ligue : comparaison match par match sur les
// matchs terminés du tournoi de la ligue. Rien n'est dévoilé avant la fin d'un match.
const total = (p) => (p ? (p.pointsEarned || 0) + (p.bonusPoints || 0) : 0);

const sum = (list) => list.reduce((s, p) => s + (p.pointsEarned || 0), 0);
const versus = (me, them) => (me > them ? 'me' : them > me ? 'them' : 'draw');

// Poules terminées : une ligne par poule, points cumulés sur les tireurs pronostiqués.
function poolRows(pools, mine, theirs) {
  return pools.flatMap((pool) => {
    const ids = new Set(pool.fencers.map((f) => f.id));
    const a = mine.filter((p) => ids.has(p.fencerId)),
      b = theirs.filter((p) => ids.has(p.fencerId));
    if (!a.length && !b.length) return [];
    const side = (list) =>
      list.length
        ? {
            prediction: `${list.length} tireur${list.length > 1 ? 's' : ''} pronostiqué${list.length > 1 ? 's' : ''}`,
            points: sum(list),
          }
        : null;
    return [
      {
        kind: 'pool',
        poolId: pool.id,
        name: pool.name,
        competition: pool.competition?.name || null,
        round: null,
        result: 'poule terminée',
        me: side(a),
        them: side(b),
        winner: versus(sum(a), sum(b)),
      },
    ];
  });
}

// Podiums officiels publiés : une ligne par épreuve.
function podiumRows(competitions, mine, theirs) {
  return competitions.flatMap((c) => {
    const a = mine.find((p) => p.competitionId === c.id),
      b = theirs.find((p) => p.competitionId === c.id);
    if (!a && !b) return [];
    const side = (p) => (p ? { prediction: `Or : ${p.gold}`, points: p.pointsEarned || 0 } : null);
    return [
      {
        kind: 'podium',
        competitionId: c.id,
        name: 'Podium',
        competition: c.name,
        round: null,
        result: 'podium officiel publié',
        me: side(a),
        them: side(b),
        winner: versus(a?.pointsEarned || 0, b?.pointsEarned || 0),
      },
    ];
  });
}

function buildDuel(matches, mine, theirs, extra = {}) {
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
        kind: 'match',
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
        winner: versus(me, them),
      };
    })
    .concat(
      poolRows(extra.pools || [], extra.poolMine || [], extra.poolTheirs || []),
      podiumRows(extra.podiums || [], extra.podiumMine || [], extra.podiumTheirs || []),
    );
  const points = (key) => rows.reduce((s, r) => s + (r[key]?.points || 0), 0);
  return {
    rows,
    totals: {
      me: points('me'),
      them: points('them'),
      won: rows.filter((r) => r.winner === 'me').length,
      lost: rows.filter((r) => r.winner === 'them').length,
      drawn: rows.filter((r) => r.winner === 'draw').length,
    },
  };
}

module.exports = { buildDuel };
