// Page publique d'un tournoi (sans compte) : lieu, dates, podiums, tableaux et classement des
// pronostiqueurs. Aucune donnée personnelle hors pseudonyme abrégé ; aucun pronostic individuel.
const express = require('express');
const db = require('../lib/prisma');
const { reportError } = require('../lib/report');
const { id } = require('../services/poolRules');
const { buildResults, publicName } = require('../services/eventResults');
const { withCountries } = require('../services/matchCountries');

const router = express.Router();
const CONFIG = 'Configuration FTL validée';

router.get('/tournaments/:tournamentId', async (req, res) => {
  try {
    const tournamentId = id(req.params.tournamentId);
    const t = await db.tournament.findUnique({
      where: { id: tournamentId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        competitions: {
          select: {
            id: true,
            name: true,
            createdAt: true,
            podiumFormat: true,
            podiumRoster: true,
            officialPodium: true,
            podiumResolvedAt: true,
            resultsSourceUrl: true,
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!t) return res.status(404).json({ error: 'Tournoi introuvable.' });
    const ids = t.competitions.map((c) => c.id);
    const { CORRECTION } = require('../services/schedule');
    const audits = await db.auditLog.findMany({
      where: { action: { in: [CONFIG, CORRECTION] }, targetType: 'Competition', targetId: { in: ids } },
      orderBy: { id: 'asc' },
      select: { targetId: true, after: true, action: true },
    });
    const configs = new Map();
    for (const a of audits)
      configs.set(a.targetId, a.action === CONFIG ? a.after : { ...(configs.get(a.targetId) || {}), ...a.after });
    // En cours ou terminé : toutes les épreuves sont montrées (podium seulement une fois publié).
    const all = t.competitions.map((c) => ({ ...c, officialPodium: c.officialPodium || null }));
    const finished = buildResults([{ ...t, competitions: all }], { configs })[0];
    const matches = await db.match.findMany({
      where: { competitionId: { in: ids }, OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] },
      include: { competition: { select: { podiumRoster: true } } },
      orderBy: { id: 'asc' },
    });
    const table = await require('../services/standings').standings(db, { tournamentId });
    res.json({
      id: t.id,
      name: t.name,
      start: finished?.start || null,
      end: finished?.end || null,
      city: finished?.city || null,
      countries: finished?.countries || [],
      competitions: t.competitions.map((c) => ({
        id: c.id,
        name: c.name,
        format: c.podiumFormat,
        podium: finished?.competitions.find((x) => x.id === c.id)?.podium || [],
        sourceUrl: c.resultsSourceUrl || null,
        matches: matches
          .filter((m) => m.competitionId === c.id)
          .map((m) => {
            const x = withCountries(m);
            return {
              id: x.id,
              round: x.round,
              sourceKey: x.sourceKey,
              player1: x.player1,
              player2: x.player2,
              player1Country: x.player1Country,
              player2Country: x.player2Country,
              seed1: x.seed1,
              seed2: x.seed2,
              score1: x.isFinished ? x.score1 : null,
              score2: x.isFinished ? x.score2 : null,
              winner: x.isFinished || x.progressionConfirmedAt ? x.winner : null,
              isFinished: x.isFinished,
              resultType: x.resultType,
              pointsPending: x.pointsPending,
              progressionConfirmedAt: x.progressionConfirmedAt,
              startsAt: x.startsAt,
              strip: x.strip,
            };
          }),
      })),
      leaderboard: table
        .filter((r) => r.totalPoints > 0)
        .slice(0, 10)
        .map((r) => ({ rank: r.rank, name: publicName(r.name), points: r.totalPoints })),
      players: table.filter((r) => r.totalPoints > 0).length,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'page publique');
    res.status(500).json({ error: 'Page indisponible.' });
  }
});

module.exports = router;
