const router = require('express').Router(),
  db = require('../lib/prisma');
const { id, fencerClosed, poolPoints } = require('../services/poolRules');
const { matchClosed, closesAt, podiumClosed } = require('../lib/matchLock');
const { calculateMatchPoints } = require('../services/matchPoints');
const { fields, verifiedPodium, predictionIds } = require('../services/podiumRules');
const { timedMatches } = require('../services/roundTiming');
const { standings } = require('../services/standings');
const { buildSeason } = require('../services/season');
const { computeBadges } = require('../services/badges');
router.use(require('../middleware/auth'));
const { reportError } = require('../lib/report');
// Lignes « Mes pronostics » d'une épreuve : matchs, poules et podium, avec statut et points.
async function competitionPredictions(competition, userId) {
  const competitionId = competition.id;
  const [matches, pools, podium] = await Promise.all([
    db.match.findMany({
      where: { competitionId },
      include: { predictions: { where: { userId } } },
      orderBy: { startsAt: 'asc' },
    }),
    db.pool.findMany({
      where: { competitionId },
      include: { fencers: { include: { predictions: { where: { userId } } }, orderBy: { position: 'asc' } } },
    }),
    db.podiumPrediction.findUnique({ where: { userId_competitionId: { userId, competitionId } } }),
  ]);
  const rounds = await db.matchRound.findMany({ where: { competitionId } });
  const contextual = await timedMatches(db, matches);
  const rows = [];
  for (const m of contextual) {
    const p = m.predictions[0],
      finished = m.isFinished && !m.pointsPending,
      closed = matchClosed(m);
    let details = [];
    if (m.resultType === 'CANCELLED') {
      const originalKey = m.sourceKey?.replace(/^cancelled:\d+:/, '');
      const replacement = contextual.find(
        (x) => x.resultType !== 'CANCELLED' && x.sourceKey === originalKey && x.sourceUrl === m.sourceUrl,
      );
      if (p)
        rows.push({
          key: `match-${m.id}`,
          type: 'Match',
          name: `${m.player1} / ${m.player2}`,
          round: m.round,
          status: 'Annulé',
          prediction: `${p.predictedScore1} – ${p.predictedScore2}`,
          result: 'Affiche retirée du tableau officiel',
          points: 0,
          details: ['Tableau officiel modifié : ancien pronostic annulé, sans attribution ni retrait de points.'],
          replacement:
            replacement && !matchClosed(replacement)
              ? {
                  key: `match-${replacement.id}`,
                  name: `${replacement.player1} / ${replacement.player2}`,
                  saved: replacement.predictions.length > 0,
                }
              : null,
          sourceUrl: m.sourceUrl,
        });
      continue;
    }
    if (p && finished) {
      const total = calculateMatchPoints(
        p.predictedScore1,
        p.predictedScore2,
        m.score1,
        m.score2,
        m.winner,
        m.resultType,
      );
      const exact =
        m.resultType !== 'MEDICAL_WITHDRAWAL' && p.predictedScore1 === m.score1 && p.predictedScore2 === m.score2;
      details = [`Bon vainqueur : +${total - (exact ? 3 : 0)}`, `Score exact : +${exact ? 3 : 0}`];
      if (p.bonusPoints) details.push(`Bonus outsider : +${p.bonusPoints}`);
    }
    rows.push({
      key: `match-${m.id}`,
      type: 'Match',
      name: `${m.player1} / ${m.player2}`,
      round: m.round,
      status: m.pointsPending
        ? 'Vérification'
        : finished
          ? 'Terminé'
          : closed
            ? 'Clos'
            : p
              ? 'Enregistré'
              : 'À compléter',
      prediction: p ? `${p.predictedScore1} – ${p.predictedScore2}` : null,
      result: m.pointsPending
        ? 'Points en attente de validation'
        : finished
          ? m.resultType === 'MEDICAL_WITHDRAWAL'
            ? `Retrait médical · ${m.winner === 1 ? m.player1 : m.player2} qualifié(e)`
            : `${m.score1} – ${m.score2}`
          : null,
      points: p && finished ? p.pointsEarned + (p.bonusPoints || 0) : null,
      details,
      startsAt: m.startsAt,
      closesAt: closesAt(m),
      manualUnlockUntil: m.manualUnlockUntil,
      awaitingPreviousRound: m.awaitingPreviousRound,
      timingUnverified: m.timingUnverified,
      sourceCheckedAt: m.sourceCheckedAt,
      sourceUrl: m.sourceUrl,
    });
  }
  for (const pool of pools)
    for (const f of pool.fencers) {
      const p = f.predictions[0],
        closed = fencerClosed(pool, f);
      const pts = p && pool.isFinal ? poolPoints(p, f, pool.fencers.length) : null;
      rows.push({
        key: `pool-${f.id}`,
        type: 'Poule',
        name: `${pool.name} · ${f.name}`,
        status: pool.isFinal ? 'Terminé' : closed ? 'Clos' : p ? 'Enregistré' : 'À compléter',
        prediction: p ? `${p.wins} V · indice ${p.indicator}` : null,
        result: pool.isFinal ? `${f.wins} V · indice ${f.indicator}` : null,
        points: pts ? p.pointsEarned : null,
        details: pts ? [`Victoires : +${pts.winsPoints}`, `Indice : +${pts.indicatorPoints}`] : [],
        sourceCheckedAt: pool.sourceCheckedAt,
        sourceUrl: pool.sourceUrl,
      });
    }
  let official = null;
  try {
    official = verifiedPodium(competition);
  } catch {}
  const slotNames = { gold: 'Or', silver: 'Argent', bronze1: 'Bronze', bronze2: 'Bronze' };
  let details = [];
  if (podium && official) {
    try {
      const selected = predictionIds(competition, podium),
        all = Object.values(official);
      details = fields(competition.podiumFormat).map((k) => {
        const exact = k.startsWith('bronze')
          ? [official.bronze1, official.bronze2].includes(selected[k])
          : official[k] === selected[k];
        return `${slotNames[k]} · ${podium[k]} : +${exact ? 15 : all.includes(selected[k]) ? 5 : 0}`;
      });
    } catch {
      details = ['Ancien choix à vérifier par l’administrateur.'];
    }
  }
  rows.push({
    key: 'podium',
    type: 'Podium',
    name: 'Podium de l’épreuve',
    status: competition.podiumResolvedAt
      ? 'Terminé'
      : podiumClosed(competition, matches)
        ? 'Clos'
        : podium
          ? 'Enregistré'
          : 'À compléter',
    prediction: podium
      ? fields(competition.podiumFormat)
          .map((k) => podium[k])
          .join(' / ')
      : null,
    result: official
      ? fields(competition.podiumFormat)
          .map((k) => competition.podiumRoster.find((e) => e.id === official[k])?.name)
          .join(' / ')
      : null,
    points: podium && competition.podiumResolvedAt ? podium.pointsEarned : null,
    details,
    sourceCheckedAt: competition.resultsVerifiedAt,
    sourceUrl: competition.resultsSourceUrl,
  });
  return {
    competition: { id: competition.id, name: competition.name },
    rows,
    rounds: require('../services/playerExperience').roundSummaries(matches, rounds),
  };
}
const ALL_LIMIT = 60;
// Tous les pronostics du joueur, toutes épreuves confondues (indépendant de l'épreuve sélectionnée).
router.get('/predictions/all', async (req, res) => {
  try {
    const userId = req.user.userId;
    const [m, p, podium] = await Promise.all([
      db.prediction.findMany({ where: { userId }, select: { match: { select: { competitionId: true } } } }),
      db.poolPrediction.findMany({
        where: { userId },
        select: { fencer: { select: { pool: { select: { competitionId: true } } } } },
      }),
      db.podiumPrediction.findMany({ where: { userId }, select: { competitionId: true } }),
    ]);
    const ids = [
      ...new Set([
        ...m.map((x) => x.match.competitionId),
        ...p.map((x) => x.fencer.pool.competitionId),
        ...podium.map((x) => x.competitionId),
      ]),
    ];
    const competitions = await db.competition.findMany({
      where: { id: { in: ids } },
      include: { tournament: { select: { id: true, name: true, archivedAt: true, createdAt: true } } },
      orderBy: [{ tournament: { createdAt: 'desc' } }, { createdAt: 'desc' }],
      take: ALL_LIMIT,
    });
    // Quatre épreuves à la fois : assez rapide sans saturer les connexions à la base.
    const computed = [];
    for (let i = 0; i < competitions.length; i += 4)
      computed.push(...(await Promise.all(competitions.slice(i, i + 4).map((c) => competitionPredictions(c, userId)))));
    const events = [];
    for (const [i, c] of competitions.entries()) {
      const { rows } = computed[i];
      const active = rows.filter((r) => r.status !== 'Annulé');
      events.push({
        tournament: { id: c.tournament.id, name: c.tournament.name, archived: !!c.tournament.archivedAt },
        competition: { id: c.id, name: c.name },
        saved: active.filter((r) => r.prediction).length,
        toComplete: active.filter((r) => r.status === 'À compléter').length,
        points: rows.reduce((sum, r) => sum + (r.points || 0), 0),
        rows: rows.filter((r) => r.prediction),
      });
    }
    res.json({ events, truncated: ids.length > competitions.length });
  } catch (e) {
    reportError(e, 'personal');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Pronostics indisponibles.' });
  }
});
// Récap de fin d'épreuve : classement dans l'épreuve, points par phase, meilleur pronostic.
const PHASES = ['T512', 'T256', 'T128', 'T64', 'T32', 'T16', 'T8', 'T4', 'Bronze', 'T2'];
async function competitionRecap(competition, userId) {
  const { rows } = await competitionPredictions(competition, userId);
  const final = await db.match.findFirst({
    where: { competitionId: competition.id, round: 'T2', isFinished: true },
    select: { id: true },
  });
  const scored = rows.filter((r) => r.prediction && r.status !== 'Annulé' && r.points !== null);
  const sum = (list) => list.reduce((n, r) => n + (r.points || 0), 0);
  const phases = [];
  const pools = scored.filter((r) => r.type === 'Poule');
  if (pools.length) phases.push({ phase: 'Poules', points: sum(pools), count: pools.length });
  for (const round of PHASES) {
    const list = scored.filter((r) => r.type === 'Match' && r.round === round);
    if (list.length) phases.push({ phase: round, points: sum(list), count: list.length });
  }
  const podium = scored.filter((r) => r.type === 'Podium');
  if (podium.length) phases.push({ phase: 'Podium', points: sum(podium), count: 1 });
  const matches = scored.filter((r) => r.type === 'Match' && r.status === 'Terminé');
  const exact = matches.filter((r) => r.details.some((d) => d === 'Score exact : +3')).length;
  const winners = matches.filter((r) => r.points > 0).length;
  const best = [...scored].sort((a, b) => b.points - a.points)[0] || null;
  const table = await standings(db, { competitionId: competition.id });
  const me = table.find((r) => r.id === userId);
  return {
    competition: { id: competition.id, name: competition.name, tournamentId: competition.tournamentId },
    tournamentName: competition.tournament?.name || '',
    finished: Boolean(competition.podiumResolvedAt || final),
    points: sum(scored),
    predictions: scored.length,
    rank: me?.rank ?? null,
    players: table.length,
    phases,
    exact,
    winners,
    played: matches.length,
    best:
      best && best.points > 0
        ? {
            type: best.type,
            name: best.name,
            round: best.round || null,
            prediction: best.prediction,
            result: best.result,
            points: best.points,
          }
        : null,
  };
}
router.get('/recap/:competitionId', async (req, res) => {
  try {
    const competition = await db.competition.findUnique({
      where: { id: id(req.params.competitionId) },
      include: { tournament: { select: { name: true } } },
    });
    if (!competition) return res.status(404).json({ error: 'Épreuve introuvable.' });
    res.json(await competitionRecap(competition, req.user.userId));
  } catch (e) {
    reportError(e, 'personal');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Récap indisponible.' });
  }
});
router.get('/predictions', async (req, res) => {
  try {
    const competitionId = id(req.query.competitionId);
    const competition = await db.competition.findUnique({ where: { id: competitionId } });
    if (!competition) return res.status(404).json({ error: 'Épreuve introuvable.' });
    res.json(await competitionPredictions(competition, req.user.userId));
  } catch (e) {
    reportError(e, 'personal');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Pronostics indisponibles.' });
  }
});
router.get('/summary/:tournamentId', async (req, res) => {
  try {
    const tournamentId = id(req.params.tournamentId),
      userId = req.user.userId;
    const general = req.query.scope === 'general',
      leagueId = req.query.leagueId ? Number(req.query.leagueId) : null;
    if (leagueId !== null && (!Number.isSafeInteger(leagueId) || leagueId < 1))
      return res.status(400).json({ error: 'Groupe invalide.' });
    const league = leagueId
      ? await db.league.findUnique({ where: { id: leagueId }, include: { members: true } })
      : null;
    if (leagueId && (!league || league.archivedAt || !league.members.some((m) => m.userId === userId && !m.leftAt)))
      return res.status(403).json({ error: 'Ce groupe est privé.' });
    let rows = await standings(db, general ? {} : { tournamentId });
    if (league) {
      const start = general
        ? null
        : await require('../services/club').tournamentStart(db, {
            id: tournamentId,
            competitions: await db.competition.findMany({ where: { tournamentId }, select: { id: true } }),
          });
      const counted = require('../services/groups').membersFor(league, {
        start,
        tournamentId: general ? null : tournamentId,
      });
      rows = require('../services/ranking').rankRows(rows.filter((r) => counted.some((m) => m.userId === r.id)));
    }
    const eventScope = general ? {} : { tournamentId };
    const predictions = await db.prediction.findMany({
      where: {
        userId,
        match: {
          competition: eventScope,
          isFinished: true,
          OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }],
        },
      },
      include: { match: true },
    });
    const exact = predictions.filter(
      (p) =>
        p.match.resultType !== 'MEDICAL_WITHDRAWAL' &&
        p.predictedScore1 === p.match.score1 &&
        p.predictedScore2 === p.match.score2,
    ).length;
    const winners = predictions.filter(
      (p) =>
        calculateMatchPoints(
          p.predictedScore1,
          p.predictedScore2,
          p.match.score1,
          p.match.score2,
          p.match.winner,
          p.match.resultType,
        ) > 0,
    ).length;
    const progress = await require('../services/rankingHistory').rankProgress(db, tournamentId, userId);
    const tournament = await db.tournament.findUnique({
      where: { id: tournamentId },
      include: { competitions: { select: { id: true, name: true, podiumResolvedAt: true } } },
    });
    if (!tournament && !general) return res.status(404).json({ error: 'Tournoi introuvable.' });
    const scopeCompetitions = general
      ? await db.competition.findMany({ select: { id: true, name: true, podiumResolvedAt: true } })
      : tournament.competitions;
    const allRounds = await db.matchRound.findMany({
      where: { competitionId: { in: scopeCompetitions.map((c) => c.id) } },
    });
    const allMatches = await db.match.findMany({
      where: { competition: eventScope },
      include: { predictions: { where: { userId } } },
    });
    const perRound = scopeCompetitions.flatMap((c) =>
      require('../services/playerExperience')
        .roundSummaries(
          allMatches.filter((m) => m.competitionId === c.id),
          allRounds.filter((r) => r.competitionId === c.id),
        )
        .filter((r) => r.completed && r.saved > 0)
        .map((r) => ({ ...r, competition: c.name })),
    );
    const bestRound = perRound.sort((a, b) => b.points - a.points)[0] || null;
    const complete = !general && scopeCompetitions.length > 0 && scopeCompetitions.every((c) => c.podiumResolvedAt);
    res.json({
      tournamentName: general
        ? 'Classement général'
        : league
          ? `${league.kind === 'CLUB' ? 'Club' : 'Groupe d’amis'} · ${league.name} — ${tournament.name}`
          : tournament.name,
      complete,
      bestRound,
      progress,
      ranking: rows.find((r) => r.id === userId),
      players: rows.length,
      played: predictions.length,
      exact,
      winners,
      accuracy: predictions.length ? Math.round((winners * 100) / predictions.length) : null,
    });
  } catch (e) {
    reportError(e, 'personal');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Bilan indisponible.' });
  }
});
// Historique complet d'une saison (1er septembre → 31 août), tous tournois confondus.
// Droit d'accès et de portabilité (RGPD art. 15 et 20) : toutes les données du compte, en JSON.
router.get('/export', async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, predictions, poolPredictions, podiums, picks, adjustments, memberships, devices, reactions, comments] =
      await Promise.all([
        db.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, email: true, isAdmin: true, createdAt: true, totpEnabledAt: true },
        }),
        db.prediction.findMany({
          where: { userId },
          include: { match: { select: { player1: true, player2: true, round: true, competitionId: true } } },
        }),
        db.poolPrediction.findMany({
          where: { userId },
          include: { fencer: { select: { name: true, pool: { select: { name: true, competitionId: true } } } } },
        }),
        db.podiumPrediction.findMany({ where: { userId } }),
        db.challengePick.findMany({ where: { userId }, include: { challenge: { select: { name: true } } } }),
        db.pointAdjustment.findMany({ where: { userId } }),
        db.leagueMember.findMany({ where: { userId }, include: { league: { select: { name: true, kind: true } } } }),
        db.pushSubscription.findMany({
          where: { userId },
          select: { createdAt: true, enabled: true, tournamentIds: true, competitionIds: true, preferences: true },
        }),
        db.matchReaction.findMany({ where: { userId }, select: { matchId: true, emoji: true, createdAt: true } }),
        db.matchComment.findMany({
          where: { userId },
          select: { matchId: true, text: true, createdAt: true, hiddenAt: true },
        }),
      ]);
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    res.setHeader('Content-Disposition', 'attachment; filename="pronos-escrime-mes-donnees.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: user,
      matchPredictions: predictions,
      poolPredictions,
      podiumPredictions: podiums,
      challengePicks: picks,
      pointAdjustments: adjustments,
      leagues: memberships,
      notificationDevices: devices,
      matchReactions: reactions,
      matchComments: comments,
    });
  } catch (error) {
    reportError(error, 'export');
    res.status(500).json({ error: 'Export impossible. Réessayez.' });
  }
});

router.get('/season', async (req, res) => {
  try {
    const userId = req.user.userId;
    let requested = null;
    if (req.query.season !== undefined) {
      requested = Number(req.query.season);
      if (!Number.isInteger(requested) || requested < 2000 || requested > 2100)
        return res.status(400).json({ error: 'Saison invalide.' });
    }
    const [predictions, poolPredictions, podiums, challengePicks, adjustments] = await Promise.all([
      db.prediction.findMany({ where: { userId }, include: { match: true } }),
      db.poolPrediction.findMany({
        where: { userId },
        include: { fencer: { include: { pool: { include: { _count: { select: { fencers: true } } } } } } },
      }),
      db.podiumPrediction.findMany({ where: { userId }, include: { competition: true } }),
      db.challengePick.findMany({ where: { userId }, include: { challenge: true } }),
      db.pointAdjustment.findMany({ where: { userId } }),
    ]);
    const challengeMatches = challengePicks.length
      ? await db.match.findMany({ where: { id: { in: challengePicks.map((p) => p.challenge.matchId) } } })
      : [];
    const competitionIds = [
      ...new Set([
        ...predictions.map((p) => p.match.competitionId),
        ...poolPredictions.map((p) => p.fencer.pool.competitionId),
        ...podiums.map((p) => p.competitionId),
        ...challengeMatches.map((m) => m.competitionId),
        ...adjustments.map((a) => a.competitionId).filter(Boolean),
      ]),
    ];
    const tournamentIds = adjustments.map((a) => a.tournamentId).filter(Boolean);
    const tournaments = await db.tournament.findMany({
      where: { OR: [{ competitions: { some: { id: { in: competitionIds } } } }, { id: { in: tournamentIds } }] },
      include: { competitions: { select: { id: true, name: true } } },
    });
    const allCompetitionIds = tournaments.flatMap((t) => t.competitions.map((c) => c.id));
    const [firstMatches, firstPools] = allCompetitionIds.length
      ? await Promise.all([
          db.match.groupBy({
            by: ['competitionId'],
            where: { competitionId: { in: allCompetitionIds }, startsAt: { not: null } },
            _min: { startsAt: true },
          }),
          db.pool.groupBy({
            by: ['competitionId'],
            where: { competitionId: { in: allCompetitionIds } },
            _min: { closesAt: true },
          }),
        ])
      : [[], []];
    const firstDates = new Map();
    for (const [rows, field] of [
      [firstMatches, 'startsAt'],
      [firstPools, 'closesAt'],
    ])
      for (const r of rows) {
        const d = r._min[field];
        if (d && (!firstDates.has(r.competitionId) || new Date(d) < new Date(firstDates.get(r.competitionId))))
          firstDates.set(r.competitionId, d);
      }
    const season = buildSeason(
      { predictions, poolPredictions, podiums, challengePicks, challengeMatches, adjustments, tournaments, firstDates },
      requested,
    );
    // Trophées : matchs et pronostics de tous les joueurs sur les épreuves de la saison affichée.
    const seasonCompetitions = season.tournaments.flatMap((t) => t.competitions.map((c) => c.id));
    const seasonMatches = seasonCompetitions.length
      ? await db.match.findMany({
          where: { competitionId: { in: seasonCompetitions } },
          select: { id: true, competitionId: true, round: true, isFinished: true, resultType: true },
        })
      : [];
    const everyone = seasonMatches.length
      ? await db.prediction.findMany({
          where: { matchId: { in: seasonMatches.filter((m) => m.isFinished).map((m) => m.id) } },
          select: { userId: true, matchId: true, pointsEarned: true, bonusPoints: true },
        })
      : [];
    season.badges = computeBadges(season, { userId, matches: seasonMatches, predictions: everyone });
    res.json(season);
  } catch (e) {
    reportError(e, 'saison');
    res.status(500).json({ error: 'Historique de saison indisponible.' });
  }
});
module.exports = router;
module.exports.competitionRecap = competitionRecap;
