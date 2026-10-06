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

// Données publiques d'un tournoi (null s'il n'existe pas) : utilisées par l'API et par les pages
// rendues pour les robots (moteurs de recherche, aperçus de liens).
async function publicTournament(tournamentId) {
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
  if (!t) return null;
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
  // Joueurs retirés du classement public (Mon compte) : leur rang reste, leur pseudo est masqué.
  const hidden = new Set(
    (await db.user.findMany({ where: { publicListing: false }, select: { id: true } })).map((u) => u.id),
  );
  return {
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
      .map((r) => ({
        rank: r.rank,
        name: hidden.has(r.id) ? 'Pronostiqueur anonyme' : publicName(r.name),
        points: r.totalPoints,
      })),
    players: table.filter((r) => r.totalPoints > 0).length,
  };
}

router.get('/tournaments/:tournamentId', async (req, res) => {
  try {
    const data = await publicTournament(id(req.params.tournamentId));
    if (!data) return res.status(404).json({ error: 'Tournoi introuvable.' });
    res.json(data);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'page publique');
    res.status(500).json({ error: 'Page indisponible.' });
  }
});

// Page du tournoi rendue côté serveur pour les robots (moteurs de recherche, aperçus de liens) : le site
// leur renvoie ici /tournoi/:id, avec le même contenu que la page de l'application.
const { tournamentPage, sitemap, SITE } = require('../services/publicHtml');
router.get('/tournaments/:tournamentId/share', async (req, res) => {
  let tournamentId;
  try {
    tournamentId = id(req.params.tournamentId);
  } catch {
    return res.redirect(302, SITE);
  }
  try {
    const data = await publicTournament(tournamentId);
    if (!data) return res.status(404).type('html').send('<!doctype html><title>Tournoi introuvable</title>');
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(tournamentPage(data));
  } catch (error) {
    reportError(error, 'page publique (robots)');
    res.redirect(302, `${SITE}/tournoi/${tournamentId}`);
  }
});

// Tournois publics (accueil sans compte) : du plus récent au plus ancien.
async function publicList() {
  const tournaments = await db.tournament.findMany({
    where: { competitions: { some: {} } },
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
    orderBy: { id: 'desc' },
    take: 200,
  });
  const ids = tournaments.flatMap((t) => t.competitions.map((c) => c.id));
  const { CORRECTION } = require('../services/schedule');
  const audits = await db.auditLog.findMany({
    where: { action: { in: [CONFIG, CORRECTION] }, targetType: 'Competition', targetId: { in: ids } },
    orderBy: { id: 'asc' },
    select: { targetId: true, after: true, action: true },
  });
  const configs = new Map();
  for (const a of audits)
    configs.set(a.targetId, a.action === CONFIG ? a.after : { ...(configs.get(a.targetId) || {}), ...a.after });
  const finished = new Map(buildResults(tournaments, { configs }).map((r) => [r.id, r]));
  return tournaments.map((t) => {
    const r = finished.get(t.id);
    return {
      id: t.id,
      name: t.name,
      start: r?.start || null,
      end: r?.end || null,
      city: r?.city || null,
      countries: r?.countries || [],
      finished: Boolean(r && r.competitions.length === t.competitions.length),
      updatedAt: t.createdAt,
    };
  });
}
router.get('/tournaments', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json((await publicList()).slice(0, 12).map(({ updatedAt, ...t }) => t));
  } catch (error) {
    reportError(error, 'liste publique');
    res.status(500).json({ error: 'Liste indisponible.' });
  }
});
router.get('/sitemap.xml', async (req, res) => {
  try {
    const list = await publicList();
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(sitemap(list.map((t) => ({ id: t.id, updatedAt: t.end || t.updatedAt }))));
  } catch (error) {
    reportError(error, 'plan du site');
    res.status(500).type('text/plain').send('Plan du site indisponible.');
  }
});

module.exports = router;
