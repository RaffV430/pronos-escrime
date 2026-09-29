// Historique d'un joueur sur une saison d'escrime (1er septembre → 31 août).
// Fonctions pures : la route lit la base, ce module assemble et calcule.
const { calculateMatchPoints } = require('./matchPoints');
const { challengePoints } = require('./communityRules');
const { adjustForAnnulled } = require('./poolRules');

// Saison désignée par son année de début : 2026 = saison 2026-2027.
function seasonOf(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}
const seasonLabel = (season) => `${season}-${season + 1}`;

// Date d'un tournoi : premier match ou première poule connus, sinon sa création.
function tournamentDates(tournaments, firstDates) {
  const dates = new Map();
  for (const t of tournaments) {
    const known = (t.competitions || []).map((c) => firstDates.get(c.id)).filter(Boolean);
    const first = known.length ? new Date(Math.min(...known.map((d) => new Date(d).getTime()))) : new Date(t.createdAt);
    dates.set(t.id, first);
  }
  return dates;
}

function matchRow(p) {
  const m = p.match;
  const base = {
    key: `match-${p.id}`,
    type: 'Match',
    matchId: m.id,
    competitionId: m.competitionId,
    resultAt: m.resultRegisteredAt || null,
    name: `${m.player1} / ${m.player2}`,
    round: m.round || null,
    date: m.startsAt || null,
    prediction: `${p.predictedScore1} – ${p.predictedScore2}`,
  };
  if (m.resultType === 'CANCELLED')
    return { ...base, outcome: 'cancelled', result: 'Affiche annulée', points: 0, details: [] };
  if (!m.isFinished) return { ...base, outcome: 'pending', result: null, points: null, details: [] };
  const medical = m.resultType === 'MEDICAL_WITHDRAWAL';
  const expected = calculateMatchPoints(
    p.predictedScore1,
    p.predictedScore2,
    m.score1,
    m.score2,
    m.winner,
    m.resultType,
  );
  const exact = !medical && p.predictedScore1 === m.score1 && p.predictedScore2 === m.score2;
  const scoreGap =
    !medical && Number.isInteger(m.score1) && Number.isInteger(m.score2)
      ? Math.abs(p.predictedScore1 - m.score1) + Math.abs(p.predictedScore2 - m.score2)
      : null;
  const bonus = p.bonusPoints || 0;
  const points = (p.pointsEarned ?? expected) + bonus;
  return {
    ...base,
    outcome: exact ? 'exact' : points > 0 ? 'points' : 'miss',
    result: medical
      ? `Retrait médical · ${m.winner === 1 ? m.player1 : m.player2} qualifié(e)`
      : `${m.score1} – ${m.score2}`,
    points,
    bonus,
    scoreGap,
    details:
      points > 0
        ? [
            `Bon vainqueur : +${points - bonus - (exact ? 3 : 0)}`,
            ...(exact ? ['Score exact : +3'] : []),
            ...(bonus ? [`Bonus outsider : +${bonus}`] : []),
          ]
        : [],
  };
}

function poolRow(p) {
  const f = p.fencer,
    pool = f.pool;
  const base = {
    key: `pool-${p.id}`,
    type: 'Poule',
    name: `${pool.name} · ${f.name}`,
    round: null,
    date: pool.closesAt || null,
    prediction: `${p.wins} V · indice ${p.indicator}`,
  };
  if (!pool.isFinal) return { ...base, outcome: 'pending', result: null, points: null, details: [] };
  const points = p.pointsEarned || 0;
  // Tireur absent ou retiré : pas de bilan, pronostic sans objet.
  if (f.wins === null || f.wins === undefined)
    return { ...base, outcome: 'cancelled', result: 'Absent ou retrait : matchs annulés', points: 0, details: [] };
  const adjusted = adjustForAnnulled(p, f, pool._count?.fencers ?? null);
  const compared = adjusted || p;
  return {
    ...base,
    outcome: points === 8 ? 'exact' : points > 0 ? 'points' : 'miss',
    result: `${f.wins} V · indice ${f.indicator}`,
    points,
    winsExact: compared.wins === f.wins,
    indicatorGap: Math.abs(compared.indicator - f.indicator),
    details: adjusted
      ? [
          `Ajusté : ${adjusted.annulled} match${adjusted.annulled > 1 ? 's' : ''} annulé${adjusted.annulled > 1 ? 's' : ''} · comparé à ${adjusted.wins} V · indice ${adjusted.indicator > 0 ? '+' : ''}${adjusted.indicator}`,
        ]
      : [],
  };
}

function podiumRow(p) {
  const c = p.competition;
  const picks = [p.gold, p.silver, p.bronze1, ...(c.podiumFormat === 'TEAM' ? [] : [p.bronze2])].filter(Boolean);
  const base = {
    key: `podium-${p.id}`,
    type: 'Podium',
    name: 'Podium',
    round: null,
    date: null,
    prediction: picks.join(' / '),
  };
  if (!c.podiumResolvedAt) return { ...base, outcome: 'pending', result: null, points: null, details: [] };
  const points = p.pointsEarned || 0;
  // Podium parfait : chaque médaille exacte (15 points chacune), seul moyen d'atteindre le maximum.
  const perfect = points === 15 * (c.podiumFormat === 'TEAM' ? 3 : 4);
  return {
    ...base,
    outcome: perfect ? 'exact' : points > 0 ? 'points' : 'miss',
    result: 'Podium officiel validé',
    points,
    perfect,
    details: perfect ? ['Podium parfait'] : [],
  };
}

function challengeRow(pick, match) {
  const base = {
    key: `challenge-${pick.id}`,
    type: 'Défi',
    name: `${pick.challenge.name} · ${match ? `${match.player1} / ${match.player2}` : 'match retiré'}`,
    round: match?.round || null,
    date: match?.startsAt || null,
    prediction: match ? (pick.winner === 1 ? match.player1 : match.player2) : null,
  };
  if (!match?.isFinished) return { ...base, outcome: 'pending', result: null, points: null, details: [] };
  const points = challengePoints(pick, match, pick.challenge.bonus);
  return {
    ...base,
    outcome: points > 0 ? 'points' : 'miss',
    result: 'Résultat publié',
    points,
    details: points ? [`Bonus défi : +${points}`] : [],
  };
}

// data : { predictions, poolPredictions, podiums, challengePicks, challengeMatches, adjustments,
//          tournaments (avec competitions), firstDates: Map(competitionId → date) }
// Ordre d'une épreuve : poules, puis matchs et défis dans l'ordre du tableau, podium en dernier.
const TYPE_ORDER = { Poule: 0, Match: 1, Défi: 1, Podium: 2 };
const chronological = (a, b) =>
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || new Date(a.date || 0) - new Date(b.date || 0);

function buildSeason(data, requested, now = new Date()) {
  const dates = tournamentDates(data.tournaments, data.firstDates);
  const compToTournament = new Map();
  for (const t of data.tournaments) for (const c of t.competitions || []) compToTournament.set(c.id, { t, c });

  const entries = [];
  const push = (competitionId, row) => {
    const ref = compToTournament.get(competitionId);
    if (ref) entries.push({ ...ref, row });
  };
  for (const p of data.predictions) push(p.match.competitionId, matchRow(p));
  for (const p of data.poolPredictions) push(p.fencer.pool.competitionId, poolRow(p));
  for (const p of data.podiums) push(p.competitionId, podiumRow(p));
  const byMatch = new Map((data.challengeMatches || []).map((m) => [m.id, m]));
  for (const pick of data.challengePicks || []) {
    const match = byMatch.get(pick.challenge.matchId);
    if (match) push(match.competitionId, challengeRow(pick, match));
  }

  const seasonFor = (tournamentId) => seasonOf(dates.get(tournamentId));
  const adjustmentSeason = (a) => {
    const tId = a.tournamentId ?? compToTournament.get(a.competitionId)?.t.id;
    return tId ? seasonFor(tId) : seasonOf(a.createdAt);
  };
  const current = seasonOf(now);
  const seasons = [
    ...new Set([current, ...entries.map((e) => seasonFor(e.t.id)), ...data.adjustments.map(adjustmentSeason)]),
  ]
    .filter((s) => s !== null)
    .sort((a, b) => b - a);
  const season = seasons.includes(requested) ? requested : current;

  const tournaments = new Map();
  for (const { t, c, row } of entries) {
    if (seasonFor(t.id) !== season) continue;
    if (!tournaments.has(t.id))
      tournaments.set(t.id, {
        id: t.id,
        name: t.name,
        date: dates.get(t.id),
        archived: Boolean(t.archivedAt),
        points: 0,
        competitions: new Map(),
      });
    const tour = tournaments.get(t.id);
    if (!tour.competitions.has(c.id)) tour.competitions.set(c.id, { id: c.id, name: c.name, points: 0, rows: [] });
    const comp = tour.competitions.get(c.id);
    comp.rows.push(row);
    comp.points += row.points || 0;
    tour.points += row.points || 0;
  }
  const adjustments = data.adjustments
    .filter((a) => adjustmentSeason(a) === season)
    .map((a) => ({ id: a.id, points: a.points, reason: a.reason || null, date: a.createdAt }));

  const rows = entries.filter((e) => seasonFor(e.t.id) === season).map((e) => e.row);
  const sum = (type) => rows.filter((r) => r.type === type).reduce((s, r) => s + (r.points || 0), 0);
  const matches = rows.filter((r) => r.type === 'Match' && ['exact', 'points', 'miss'].includes(r.outcome));
  const winners = matches.filter((r) => r.points > 0).length;
  const outsider = rows.reduce((t, r) => t + (r.bonus || 0), 0);
  const totals = {
    match: sum('Match') - outsider,
    outsider,
    pool: sum('Poule'),
    podium: sum('Podium'),
    challenge: sum('Défi'),
    adjustment: adjustments.reduce((s, a) => s + a.points, 0),
  };
  totals.total = Object.values(totals).reduce((s, v) => s + v, 0);

  const order = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
  const analysis = analyse(rows, [...tournaments.values()]);
  return {
    analysis,
    season,
    label: seasonLabel(season),
    seasons: seasons.map((s) => ({ season: s, label: seasonLabel(s) })),
    totals,
    stats: {
      predictions: rows.filter((r) => r.outcome !== 'cancelled').length,
      pending: rows.filter((r) => r.outcome === 'pending').length,
      matchesPlayed: matches.length,
      exact: matches.filter((r) => r.outcome === 'exact').length,
      winners,
      accuracy: matches.length ? Math.round((winners * 100) / matches.length) : null,
    },
    tournaments: [...tournaments.values()].sort(order).map((t) => ({
      ...t,
      competitions: [...t.competitions.values()].map((c) => ({
        ...c,
        rows: c.rows.sort(chronological),
      })),
    })),
    adjustments,
  };
}

// Tours du plus grand au plus petit tableau ; « T2 » = finale.
const ROUND_ORDER = (r) => (r === 'Bronze' ? 1.5 : Number(String(r).replace(/\D/g, '')) || 0);
const percent = (n, d) => (d ? Math.round((n * 100) / d) : null);
const average = (values) =>
  values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;

// Statistiques personnelles de la saison (matchs terminés et poules publiées uniquement).
function analyse(rows, tournaments) {
  const played = rows.filter((r) => r.type === 'Match' && ['exact', 'points', 'miss'].includes(r.outcome));
  const rounds = new Map();
  for (const r of played) {
    const key = r.round || '?';
    if (!rounds.has(key)) rounds.set(key, { round: key, played: 0, winners: 0, exact: 0, points: 0 });
    const x = rounds.get(key);
    x.played++;
    x.winners += r.points > 0 ? 1 : 0;
    x.exact += r.outcome === 'exact' ? 1 : 0;
    x.points += r.points || 0;
  }
  const byRound = [...rounds.values()]
    .sort((a, b) => ROUND_ORDER(b.round) - ROUND_ORDER(a.round))
    .map((x) => ({ ...x, accuracy: percent(x.winners, x.played) }));
  const pools = rows.filter((r) => r.type === 'Poule' && ['exact', 'points', 'miss'].includes(r.outcome));
  const competitions = tournaments.flatMap((t) =>
    [...t.competitions.values()].map((c) => ({ name: c.name, tournament: t.name, points: c.points })),
  );
  const best = competitions.sort((a, b) => b.points - a.points)[0];
  return {
    byRound,
    bestRound: byRound.filter((r) => r.played >= 3).sort((a, b) => b.accuracy - a.accuracy)[0]?.round || null,
    averageScoreGap: average(played.map((r) => r.scoreGap).filter((g) => g !== null && g !== undefined)),
    outsiderHits: played.filter((r) => r.bonus > 0).length,
    pools: {
      predicted: pools.length,
      winsExact: pools.filter((r) => r.winsExact).length,
      winsAccuracy: percent(pools.filter((r) => r.winsExact).length, pools.length),
      averageIndicatorGap: average(pools.map((r) => r.indicatorGap).filter((g) => Number.isFinite(g))),
    },
    bestCompetition: best && best.points > 0 ? best : null,
  };
}

module.exports = { seasonOf, seasonLabel, buildSeason, matchRow, analyse };
