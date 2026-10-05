// Résultats sportifs des tournois passés (onglet « Résultats »). Lecture seule, pour tout joueur connecté.
const express = require('express');
const authMiddleware = require('../middleware/auth');
const db = require('../lib/prisma');
const { reportError } = require('../lib/report');
const { buildResults } = require('../services/eventResults');

const router = express.Router();
const CONFIG = 'Configuration FTL validée';
const { CORRECTION } = require('../services/schedule');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const tournaments = await db.tournament.findMany({
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
        },
      },
    });
    const ids = tournaments.flatMap((t) => t.competitions.map((c) => c.id));
    const [audits, firstMatches] = ids.length
      ? await Promise.all([
          db.auditLog.findMany({
            where: { action: { in: [CONFIG, CORRECTION] }, targetType: 'Competition', targetId: { in: ids } },
            orderBy: { id: 'asc' },
            select: { targetId: true, after: true, action: true },
          }),
          db.match.groupBy({
            by: ['competitionId'],
            where: { competitionId: { in: ids }, startsAt: { not: null } },
            _min: { startsAt: true },
          }),
        ])
      : [[], []];
    // Configuration la plus récente, puis lieu et dates corrigés par un administrateur (même sans configuration).
    const configs = new Map();
    for (const a of audits)
      configs.set(a.targetId, a.action === CONFIG ? a.after : { ...(configs.get(a.targetId) || {}), ...a.after });
    const firstDates = new Map(firstMatches.map((r) => [r.competitionId, r._min.startsAt]));
    res.json(buildResults(tournaments, { configs, firstDates }));
  } catch (error) {
    reportError(error, 'résultats');
    res.status(500).json({ error: 'Résultats indisponibles.' });
  }
});

module.exports = router;
