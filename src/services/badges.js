// Trophées de la saison, calculés à partir des résultats (rien n'est stocké).
//  - Sniper : 3 scores exacts ou plus dans un même tournoi
//  - Série de 10 : 10 bons vainqueurs d'affilée (dans l'ordre des résultats)
//  - Flair : un bonus outsider obtenu
//  - Meilleur du tour : le plus de points de tous les joueurs sur un tour terminé
//  - Assidu : tous les matchs d'un tournoi terminé pronostiqués
const DEFS = {
  sniper: { label: 'Sniper', icon: '🎯', description: '3 scores exacts dans un même tournoi' },
  streak: { label: 'Série de 10', icon: '🔥', description: '10 bons vainqueurs d’affilée' },
  flair: { label: 'Flair', icon: '🦊', description: 'Un outsider trouvé (bonus outsider)' },
  bestRound: { label: 'Meilleur du tour', icon: '👑', description: 'Le plus de points sur un tour terminé' },
  assiduous: { label: 'Assidu', icon: '📋', description: 'Tous les matchs d’un tournoi pronostiqués' },
};
const roundName = (r) => (r === 'T2' ? 'Finale' : r === 'T4' ? 'Demi-finales' : r || 'Tour');

// season : résultat de buildSeason pour le joueur.
// matches : tous les matchs des épreuves de ces tournois { id, competitionId, round, isFinished, resultType }.
// predictions : pronostics de tous les joueurs sur ces matchs { userId, matchId, pointsEarned, bonusPoints }.
function computeBadges(season, { userId, matches, predictions }) {
  const earned = new Map();
  const award = (id, where) => {
    const b = earned.get(id) || { id, ...DEFS[id], count: 0, where: [] };
    b.count++;
    if (where && !b.where.includes(where)) b.where.push(where);
    earned.set(id, b);
  };
  const byMatch = new Map(matches.map((m) => [m.id, m]));
  const compName = new Map();
  const compTournament = new Map();
  for (const t of season.tournaments)
    for (const c of t.competitions) {
      compName.set(c.id, c.name);
      compTournament.set(c.id, t);
    }

  const matchRows = season.tournaments.flatMap((t) =>
    t.competitions.flatMap((c) => c.rows.filter((r) => r.type === 'Match').map((r) => ({ ...r, tournament: t }))),
  );

  // Sniper et Assidu, par tournoi.
  for (const t of season.tournaments) {
    const rows = matchRows.filter((r) => r.tournament.id === t.id);
    if (rows.filter((r) => r.outcome === 'exact').length >= 3) award('sniper', t.name);
    const tMatches = matches.filter(
      (m) => compTournament.get(m.competitionId)?.id === t.id && m.resultType !== 'CANCELLED',
    );
    const predicted = new Set(rows.map((r) => r.matchId));
    if (tMatches.length && tMatches.every((m) => m.isFinished) && tMatches.every((m) => predicted.has(m.id)))
      award('assiduous', t.name);
  }

  // Série de 10, dans l'ordre chronologique des résultats.
  const decided = matchRows
    .filter((r) => ['exact', 'points', 'miss'].includes(r.outcome))
    .sort((a, b) => new Date(a.resultAt || a.date || 0) - new Date(b.resultAt || b.date || 0));
  let streak = 0;
  for (const r of decided) {
    streak = r.points > 0 ? streak + 1 : 0;
    if (streak === 10) {
      award('streak', r.tournament.name);
      streak = 0; // une nouvelle série de 10 sera de nouveau récompensée
    }
  }

  // Flair.
  for (const r of matchRows) if (r.bonus > 0) award('flair', r.tournament.name);

  // Meilleur du tour : tours terminés, au moins 2 joueurs, le plus de points (ex æquo récompensés).
  const rounds = new Map();
  for (const m of matches) {
    if (m.resultType === 'CANCELLED') continue;
    const key = `${m.competitionId}|${m.round}`;
    const r = rounds.get(key) || { competitionId: m.competitionId, round: m.round, matchIds: [], done: true };
    r.matchIds.push(m.id);
    r.done = r.done && m.isFinished;
    rounds.set(key, r);
  }
  for (const r of rounds.values()) {
    if (!r.done || !r.round) continue;
    const ids = new Set(r.matchIds);
    const totals = new Map();
    for (const p of predictions) {
      if (!ids.has(p.matchId) || !byMatch.has(p.matchId)) continue;
      totals.set(p.userId, (totals.get(p.userId) || 0) + (p.pointsEarned || 0) + (p.bonusPoints || 0));
    }
    if (totals.size < 2) continue;
    const best = Math.max(...totals.values());
    if (best > 0 && totals.get(userId) === best)
      award(
        'bestRound',
        `${compTournament.get(r.competitionId)?.name || ''} · ${compName.get(r.competitionId) || ''} · ${roundName(r.round)}`,
      );
  }

  // Tous les trophées, obtenus ou non (count 0), pour afficher ceux qui restent à décrocher.
  return Object.keys(DEFS).map((id) => earned.get(id) || { id, ...DEFS[id], count: 0, where: [] });
}

module.exports = { computeBadges, BADGES: DEFS };
