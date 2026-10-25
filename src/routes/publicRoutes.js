// Page publique d'un tournoi (sans compte) : lieu, dates, podiums, tableaux et classement des
// pronostiqueurs. Aucune donnée personnelle hors pseudonyme abrégé ; aucun pronostic individuel.
const express = require('express');
const db = require('../lib/prisma');
const { reportError } = require('../lib/report');
const { id } = require('../services/poolRules');
const { buildResults, publicName, tournamentMetadata } = require('../services/eventResults');
const { withCountries } = require('../services/matchCountries');

const router = express.Router();
const CONFIG = 'Configuration FTL validée';

// Match vu sans compte : résultat officiel seulement, jamais de pronostic.
function publicMatch(m) {
  const x = withCountries(m);
  return {
    id: x.id,
    competitionId: x.competitionId,
    round: x.round,
    sourceKey: x.sourceKey,
    officialRelays: require('../services/officialRelayScores').forMatch(m),
    player1: x.player1,
    player2: x.player2,
    player1Country: x.player1Country,
    player2Country: x.player2Country,
    seed1: x.seed1,
    seed2: x.seed2,
    score1: x.isFinished && !x.pointsPending ? x.score1 : null,
    score2: x.isFinished && !x.pointsPending ? x.score2 : null,
    winner: (x.isFinished && !x.pointsPending) || x.progressionConfirmedAt ? x.winner : null,
    isFinished: x.isFinished,
    resultType: x.resultType,
    pointsPending: x.pointsPending,
    progressionConfirmedAt: x.progressionConfirmedAt,
    startsAt: x.startsAt,
    strip: x.strip,
  };
}

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
  const metadata = tournamentMetadata(t, { configs });
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
    start: metadata.start || finished?.start || null,
    end: metadata.end || finished?.end || null,
    city: metadata.city || finished?.city || null,
    countries: metadata.countries.length ? metadata.countries : finished?.countries || [],
    competitions: t.competitions.map((c) => ({
      id: c.id,
      name: c.name,
      format: c.podiumFormat,
      podium: finished?.competitions.find((x) => x.id === c.id)?.podium || [],
      sourceUrl: c.resultsSourceUrl || null,
      matches: matches.filter((m) => m.competitionId === c.id).map(publicMatch),
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
const { tournamentPage, sitemap, SITE, idOf } = require('../services/publicHtml');
// Robots : /tournoi/<tournoi>[/<épreuve>] (nom lisible + numéro, ou numéro seul).
router.get('/tournaments/:tournamentId/share', async (req, res) => {
  const tournamentId = idOf(req.params.tournamentId);
  if (!tournamentId) return res.redirect(302, SITE);
  const eventId = idOf(req.query.event);
  try {
    const data = await publicTournament(tournamentId);
    if (!data) return res.status(404).type('html').send('<!doctype html><title>Tournoi introuvable</title>');
    res.set('Cache-Control', 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400');
    res.type('html').send(tournamentPage(data, eventId));
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
    const metadata = tournamentMetadata(t, { configs });
    return {
      id: t.id,
      name: t.name,
      start: metadata.start || r?.start || null,
      end: metadata.end || r?.end || null,
      city: metadata.city || r?.city || null,
      countries: metadata.countries.length ? metadata.countries : r?.countries || [],
      finished: Boolean(r && r.competitions.length === t.competitions.length),
      competitions: t.competitions.map((c) => {
        const config = configs.get(c.id);
        // Pas de faux minuit : le compte à rebours requiert un horaire configuré.
        const start =
          config?.timezone &&
          /(?:^([01]?\d|2[0-3]):[0-5]\d$|(?:1[0-2]|0?[1-9]):[0-5]\d\s*(?:AM|PM)$)/i.test(
            config.time || config.eventTime || '',
          )
            ? require('../services/eventStart').eventStart(config)
            : null;
        return { id: c.id, name: c.name, startsAt: start == null ? null : new Date(start).toISOString() };
      }),
      updatedAt: t.createdAt,
    };
  });
}
router.get('/next-prediction', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await require('../services/nextPrediction').nextPrediction(db));
  } catch (error) {
    reportError(error, 'prochaine étape de pronostic');
    res.status(500).json({ error: 'Prochaine étape indisponible.' });
  }
});
router.get('/tournaments', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json((await publicList()).slice(0, 12).map(({ updatedAt, ...t }) => t));
  } catch (error) {
    reportError(error, 'liste publique');
    res.status(500).json({ error: 'Liste indisponible.' });
  }
});
// Calendrier des prochaines épreuves (sélection FFE), avec le tournoi de l'application quand il existe.
router.get('/calendar', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ events: await require('../services/calendarWatch').upcoming(db) });
  } catch (error) {
    reportError(error, 'calendrier public');
    res.status(500).json({ error: 'Calendrier indisponible.' });
  }
});
// Lien d'invitation (/rejoindre/<code>) : ce que la personne invitée rejoint, avant de se connecter.
router.get('/invitations/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (!/^[A-F0-9]{24}$/.test(code)) return res.status(400).json({ error: 'Lien d’invitation invalide.' });
    const league = await db.league.findUnique({
      where: { code },
      select: {
        name: true,
        kind: true,
        tournamentId: true,
        _count: { select: { members: true } },
      },
    });
    if (!league) return res.status(404).json({ error: 'Invitation introuvable ou expirée.' });
    const tournament = league.tournamentId
      ? await db.tournament.findUnique({ where: { id: league.tournamentId }, select: { id: true, name: true } })
      : null;
    res.json({
      code,
      name: league.name,
      kind: league.kind,
      tournament,
      members: league._count.members,
    });
  } catch (error) {
    reportError(error, 'invitation');
    res.status(500).json({ error: 'Invitation indisponible.' });
  }
});
router.get('/sitemap.xml', async (req, res) => {
  try {
    const list = await publicList();
    // s-maxage : le CDN du site garde le plan, servi instantanément même si le serveur se réveille.
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    res.type('application/xml').send(
      sitemap(
        list.map((t) => ({
          id: t.id,
          name: t.name,
          competitions: t.competitions,
          updatedAt: t.end || t.updatedAt,
        })),
      ),
    );
  } catch (error) {
    reportError(error, 'plan du site');
    res.status(500).type('text/plain').send('Plan du site indisponible.');
  }
});

// Onglet Résultats sans compte (/resultats) : tournois terminés, tableaux, poules (tous les assauts)
// et fiches tireurs. Données sportives officielles uniquement ; aucun pronostic.
router.get('/results', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await require('./resultsRoutes').results());
  } catch (error) {
    reportError(error, 'résultats publics');
    res.status(500).json({ error: 'Résultats indisponibles.' });
  }
});
router.get('/matches/:matchId/live-history', async (req, res) => {
  try {
    const result = await require('../services/liveHistoryStore').result(db, id(req.params.matchId));
    if (!result) return res.status(404).json({ error: 'Rencontre introuvable.' });
    res.set('Cache-Control', 'no-store').json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'historique live public');
    res.status(503).json({ error: 'Historique temporairement indisponible.' });
  }
});

router.get('/competitions/:competitionId/matches', async (req, res) => {
  try {
    const competitionId = id(req.params.competitionId);
    const matches = await db.match.findMany({
      where: { competitionId, OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] },
      include: { competition: { select: { podiumRoster: true } } },
      orderBy: { id: 'asc' },
    });
    res.set('Cache-Control', 'public, max-age=120');
    res.json(matches.map(publicMatch));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'tableau public');
    res.status(500).json({ error: 'Tableau indisponible.' });
  }
});
// Scores en direct d'une épreuve, poussés à chaque touche (Server-Sent Events). Données publiques des
// pistes FencingTimeLive, sans pronostic ; au plus une diffusion toutes les 150 ms par écran.
router.get('/competitions/:competitionId/live/stream', async (req, res) => {
  let competitionId;
  try {
    competitionId = id(req.params.competitionId);
  } catch {
    return res.status(400).end();
  }
  const live = require('../services/ftlLiveScores');
  res.set({
    'Content-Type': 'text/event-stream',
    // Autoriser gzip ; flush() conserve l’envoi immédiat de chaque trame SSE.
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.set('X-Live-Protocol', req.query.delta === '1' ? 'delta-v1' : 'snapshot');
  res.flushHeaders?.();
  let closed = false,
    timer = null,
    last = '',
    previous = null,
    sending = false,
    again = false;
  const delta = req.query.delta === '1';
  const { LIVE_WIRE, encodeLiveWire } = require('../services/liveWire');
  const packedWire = req.query.wire === LIVE_WIRE;
  const metrics = require('../lib/liveMetrics').liveMetrics.begin(res, { delta, packedWire });
  const { liveDelta } = require('../services/liveDelta');
  const output = require('../services/liveStreamOutput').liveStreamOutput(res, () => {
    if (again && !closed && !timer) {
      again = false;
      timer = setTimeout(send, 150);
    }
  });
  const send = async () => {
    timer = null;
    if (closed) return;
    if (output.blocked) {
      again = true;
      return;
    }
    if (sending) {
      again = true;
      return;
    }
    sending = true;
    try {
      const rows = await (req.query.teams === '1'
        ? live.teamOverviewFor(db, competitionId)
        : live.liveFor(db, competitionId));
      if (closed) return;
      const diff = delta ? liveDelta(previous, rows) : null;
      if (delta && !diff.message) return;
      const body = JSON.stringify(delta ? diff.message : rows);
      if (!delta && body === last) return;
      const wireBody = await encodeLiveWire(body, packedWire);
      if (closed) return;
      if (!output.write(`data: ${wireBody}\n\n`)) {
        // Un ping peut bloquer la sortie pendant la lecture asynchrone.
        again = true;
        return;
      }
      metrics.message(body, wireBody);
      last = body;
      if (delta) previous = diff.next;
    } catch (error) {
      reportError(error, 'direct des pistes');
    } finally {
      sending = false;
      if (again && !closed && !output.blocked) {
        again = false;
        if (!timer) timer = setTimeout(send, 150);
      }
    }
  };
  let unsubscribe = () => {};
  let ping = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(ping);
    output.close();
    metrics.close();
    unsubscribe();
  };
  req.once('close', close);
  res.once('close', close);
  res.once('error', close);
  try {
    unsubscribe = await live.subscribe(db, competitionId, () => {
      if (closed) return;
      if (output.blocked) {
        again = true;
        return;
      }
      if (!timer) timer = setTimeout(send, 150);
    });
    if (closed) {
      unsubscribe();
      return;
    }
    ping = setInterval(() => output.write(': ping\n\n'), 25000);
    send();
  } catch (error) {
    reportError(error, 'abonnement direct des pistes');
    close();
    res.end();
  }
});
router.get('/competitions/:competitionId/standings', async (req, res) => {
  try {
    const result = await require('../services/officialStandings').officialStandings(db, id(req.params.competitionId));
    res.set('Cache-Control', 'public, max-age=60');
    res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'classements sportifs publics');
    res.status(503).json({ error: 'Classements officiels momentanément indisponibles.' });
  }
});
router.get('/competitions/:competitionId/pools', async (req, res) => {
  try {
    const competitionId = id(req.params.competitionId);
    const { olympicCodeFor } = require('../services/matchCountries');
    const [competition, pools] = await Promise.all([
      db.competition.findUnique({ where: { id: competitionId }, select: { podiumRoster: true } }),
      db.pool.findMany({
        where: { competitionId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          isFinal: true,
          bouts: true,
          fencers: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              name: true,
              position: true,
              wins: true,
              losses: true,
              indicator: true,
              ranking: true,
              countryCode: true,
            },
          },
        },
      }),
    ]);
    res.set('Cache-Control', 'public, max-age=120');
    res.json(
      pools.map((p) => ({
        ...p,
        fencers: p.fencers.map((f) => ({
          ...f,
          countryCode: f.countryCode || olympicCodeFor(competition?.podiumRoster, f.name),
          prediction: null,
        })),
      })),
    );
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'poules publiques');
    res.status(500).json({ error: 'Poules indisponibles.' });
  }
});
router.get('/fencer', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(
      await require('../services/fencerProfile').fencerProfile(db, req.query.name, {
        club: typeof req.query.club === 'string' ? req.query.club : null,
        matchId: req.query.matchId ? Number(req.query.matchId) : null,
        affiliationId: req.query.affiliationId !== undefined ? Number(req.query.affiliationId) : null,
      }),
    );
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    reportError(error, 'fiche tireur publique');
    res.status(500).json({ error: 'Fiche indisponible.' });
  }
});

module.exports = router;
