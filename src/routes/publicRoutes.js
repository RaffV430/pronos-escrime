// Page publique d'un tournoi (sans compte) : lieu, dates, podiums, tableaux et classement des
// pronostiqueurs. Aucune donnée personnelle hors pseudonyme abrégé ; aucun pronostic individuel.
const express = require('express');
const db = require('../lib/prisma');
const { reportError } = require('../lib/report');
const { id } = require('../services/poolRules');
const { buildResults, publicName, shareText } = require('../services/eventResults');
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
    // Joueurs retirés du classement public (Mon compte) : leur rang reste, leur pseudo est masqué.
    const hidden = new Set(
      (await db.user.findMany({ where: { publicListing: false }, select: { id: true } })).map((u) => u.id),
    );
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
        .map((r) => ({
          rank: r.rank,
          name: hidden.has(r.id) ? 'Pronostiqueur anonyme' : publicName(r.name),
          points: r.totalPoints,
        })),
      players: table.filter((r) => r.totalPoints > 0).length,
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'page publique');
    res.status(500).json({ error: 'Page indisponible.' });
  }
});

// Aperçu des liens partagés (WhatsApp, Facebook, Instagram…) : les robots de ces réseaux ne lisent pas
// l'application, le site leur renvoie ici une page minimale avec les balises Open Graph du tournoi.
const SITE = 'https://www.pronos-escrime.fr';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
router.get('/tournaments/:tournamentId/share', async (req, res) => {
  let tournamentId;
  try {
    tournamentId = id(req.params.tournamentId);
  } catch {
    return res.redirect(302, SITE);
  }
  const url = `${SITE}/tournoi/${tournamentId}`;
  try {
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
    if (!t) return res.redirect(302, SITE);
    const { CORRECTION } = require('../services/schedule');
    const audits = await db.auditLog.findMany({
      where: {
        action: { in: [CONFIG, CORRECTION] },
        targetType: 'Competition',
        targetId: { in: t.competitions.map((c) => c.id) },
      },
      orderBy: { id: 'asc' },
      select: { targetId: true, after: true, action: true },
    });
    const configs = new Map();
    for (const a of audits)
      configs.set(a.targetId, a.action === CONFIG ? a.after : { ...(configs.get(a.targetId) || {}), ...a.after });
    const result = buildResults([t], { configs })[0];
    const title = `${t.name} · Pronos Escrime`;
    const description = shareText(t, result);
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pronos Escrime">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(t.name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Logo Pronos Escrime : un fleuret qui forme la lettre P">
<meta name="twitter:card" content="summary_large_image">
</head><body><p><a href="${esc(url)}">${esc(t.name)}</a> — ${esc(description)}</p></body></html>`);
  } catch (error) {
    reportError(error, 'aperçu de partage');
    res.redirect(302, url);
  }
});

module.exports = router;
