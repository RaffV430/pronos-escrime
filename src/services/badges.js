// Trophées de la saison, calculés à partir des résultats (rien n'est stocké), chacun à 4 niveaux :
//  - Sniper : scores exacts sur la saison (3, 5, 10, 20)
//  - Série : bons vainqueurs d'affilée, dans l'ordre des résultats (10, 15, 20, 30)
//  - Flair : outsiders trouvés (bonus outsider) (1, 3, 5, 10)
//  - Meilleur du tour : tours terminés où l'on a le plus de points de tous les joueurs (1, 3, 5, 10)
//  - Assidu : tournois terminés dont tous les matchs sont pronostiqués (1, 2, 4, 8)
//  - Voyant : podiums pronostiqués parfaits (chaque médaille exacte) (1, 2, 3, 5)
const plural = (n, one, many) => (n > 1 ? many : one);
const DEFS = {
  sniper: {
    label: 'Sniper',
    icon: '🎯',
    levels: [3, 5, 10, 20],
    text: (n) => `${n} ${plural(n, 'score exact', 'scores exacts')} sur la saison`,
  },
  streak: {
    label: 'Série',
    icon: '🔥',
    levels: [10, 15, 20, 30],
    text: (n) => `${n} bons vainqueurs d’affilée`,
  },
  flair: {
    label: 'Flair',
    icon: '🦊',
    levels: [1, 3, 5, 10],
    text: (n) => (n === 1 ? 'Un outsider trouvé (bonus outsider)' : `${n} outsiders trouvés (bonus outsider)`),
  },
  bestRound: {
    label: 'Meilleur du tour',
    icon: '👑',
    levels: [1, 3, 5, 10],
    text: (n) => (n === 1 ? 'Le plus de points sur un tour terminé' : `Le plus de points sur ${n} tours terminés`),
  },
  assiduous: {
    label: 'Assidu',
    icon: '📋',
    levels: [1, 2, 4, 8],
    text: (n) =>
      n === 1 ? 'Tous les matchs d’un tournoi pronostiqués' : `Tous les matchs de ${n} tournois pronostiqués`,
  },
  seer: {
    label: 'Voyant',
    icon: '🔮',
    levels: [1, 2, 3, 5],
    text: (n) => (n === 1 ? 'Un podium pronostiqué parfait' : `${n} podiums pronostiqués parfaits`),
  },
};
// Niveau atteint (0 à 4) pour une valeur, et le palier suivant.
function levelOf(levels, value) {
  const level = levels.filter((t) => value >= t).length;
  return { level, next: levels[level] ?? null };
}
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
    const exact = rows.filter((r) => r.outcome === 'exact').length;
    for (let i = 0; i < exact; i++) award('sniper', t.name);
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
  let streak = 0,
    longest = 0,
    longestWhere = null;
  for (const r of decided) {
    streak = r.points > 0 ? streak + 1 : 0;
    if (streak > longest) {
      longest = streak;
      longestWhere = r.tournament.name;
    }
  }

  // Voyant : podium parfait.
  for (const t of season.tournaments)
    for (const c of t.competitions)
      for (const r of c.rows) if (r.type === 'Podium' && r.perfect) award('seer', `${t.name} · ${c.name}`);

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

  // Tous les trophées, obtenus ou non, avec leur niveau et le palier suivant.
  return Object.entries(DEFS).map(([id, def]) => {
    const got = earned.get(id) || { where: [], count: 0 };
    const value = id === 'streak' ? longest : got.count;
    const where = id === 'streak' ? (longestWhere && longest ? [longestWhere] : []) : got.where;
    const { level, next } = levelOf(def.levels, value);
    return {
      id,
      label: def.label,
      icon: def.icon,
      level,
      maxLevel: def.levels.length,
      value,
      next,
      // Ce qui est obtenu (niveau atteint) ou, à défaut, l'objectif du premier niveau.
      description: def.text(level ? def.levels[level - 1] : def.levels[0]),
      nextText: next ? def.text(next) : null,
      count: level ? value : 0,
      where,
    };
  });
}

module.exports = { computeBadges, levelOf, BADGES: DEFS };
