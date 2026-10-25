// Scores en direct des pistes FencingTimeLive (flux temps réel « /livescores », sans connexion au compte).
// Affichage seulement : les points restent calculés sur le résultat final confirmé par l'import officiel.
const { EventEmitter } = require('node:events');
const { ORIGIN } = require('./ftlClient');
const { norm } = require('./ftlParser');
const { countryFor } = require('./matchCountries');
const { rememberLive, liveDetectedAt } = require('../lib/liveDetection');

const FRESH_MS = 3 * 60000; // une piste muette depuis 3 min n'est plus « en cours »
const REFRESH_MS = 5 * 60000; // relecture des tournois suivis
const MATCHES_MS = 10000; // rencontres d'une épreuve gardées 10 s entre deux diffusions
const MAX_TOUCHES = 150;
const GUID = /\/tournaments\/eventSchedule\/([a-f0-9]{32})$/i;
const strips = new Map(); // `${guid}:${strip}` → dernier état reçu
const bouts = new Map(); // `${guid}:${strip}:${noms}` → déroulé touche par touche
const finishedHistory = new Map(); // matchId → identités et déroulé conservés après la fin
const matchesCache = new Map(); // competitionId → { at, guid, matches }
const events = new EventEmitter();
events.setMaxListeners(500);
let tracked = new Set();
let trackedCompetitions = new Map();

const fold = (s) =>
  norm(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const side = (p) => ({
  name: String(p?.Name || '').trim(),
  country: String(p?.Country || '').replace(/^_?AIN_?$/, 'AIN'),
  score: Number.isInteger(p?.Score) ? p.Score : 0,
  lamp: Boolean(p?.ScoreLamp),
  white: Boolean(p?.WhiteLamp),
  priority: Boolean(p?.Pri),
  yellow: Number(p?.NumYellow) || 0,
  red: Number(p?.NumRed) || 0,
  pCards: Number(p?.NumPCards) || 0,
});
const boutKey = (s) => `${s.guid}:${s.strip}:${fold(s.left.name)}|${fold(s.right.name)}`;

// Déroulé : chaque changement de score devient une touche (gauche, droite, coup double ou correction).
function track(state) {
  if (!state.left.name || !state.right.name) return;
  const key = boutKey(state);
  let bout = bouts.get(key);
  if (!bout) {
    // Rencontre découverte en cours de route : le score déjà atteint sert de point de départ.
    // Chrono plein en 1re période : la rencontre n'a pas commencé, le score affiché est celui de la
    // rencontre précédente sur la piste (FencingTimeLive change les noms avant de remettre le score à zéro).
    const notStarted = state.clock >= 180 && (state.period || 1) <= 1;
    if (notStarted) {
      bouts.set(key, { last: { l: 0, r: 0 }, touches: [] });
      return;
    }
    const start = state.left.score || state.right.score;
    bout = {
      last: { l: state.left.score, r: state.right.score },
      touches: start
        ? [
            {
              l: state.left.score,
              r: state.right.score,
              by: 'start',
              clock: state.clock,
              period: state.period,
              at: state.at,
            },
          ]
        : [],
    };
    bouts.set(key, bout);
    return;
  }
  const { l, r } = bout.last,
    nl = state.left.score,
    nr = state.right.score;
  if (nl === l && nr === r) return;
  // Retour à 0–0 : nouvelle rencontre sur la piste (ou remise à zéro) — le fil repart de zéro.
  if (nl === 0 && nr === 0) {
    bout.touches = [];
    bout.last = { l: 0, r: 0 };
    return;
  }
  const by = nl < l || nr < r ? 'correction' : nl > l && nr > r ? 'double' : nl > l ? 'left' : 'right';
  bout.touches.push({ l: nl, r: nr, by, clock: state.clock, period: state.period, at: state.at });
  if (bout.touches.length > MAX_TOUCHES) bout.touches.shift();
  bout.last = { l: nl, r: nr };
}

// Message reçu → état de piste (ignoré s'il ne concerne pas un tournoi suivi ou s'il est incomplet).
function record(message, now = Date.now(), guids = tracked) {
  const guid = String(message?.TournGuid || '').toUpperCase();
  if (!guids.has(guid) || message?.StripNum == null) return null;
  const state = {
    guid,
    strip: String(message.StripNum),
    clock: Number.isFinite(message.Clock) ? message.Clock : null,
    period: Number.isFinite(message.PeriodNum) ? message.PeriodNum : null,
    left: side(message.Left),
    right: side(message.Right),
    at: now,
  };
  strips.set(`${guid}:${state.strip}`, state);
  track(state);
  events.emit('change', guid);
  return state;
}

// Déroulé remis dans l'ordre player1 / player2 de la rencontre.
const oriented = (touches, swap) =>
  touches.map((t) => ({
    score1: swap ? t.r : t.l,
    score2: swap ? t.l : t.r,
    by: { left: swap ? 2 : 1, right: swap ? 1 : 2, double: 'double', start: 'start' }[t.by] || 'correction',
    clock: t.clock,
    period: t.period,
    at: new Date(t.at).toISOString(),
  }));

// Le cache garde les identités : un changement d’ordre ne doit jamais réattribuer les touches.
function retainedHistory(match) {
  const saved = finishedHistory.get(match.id);
  if (!saved?.history?.length) return null;
  const same = fold(saved.player1) === fold(match.player1) && fold(saved.player2) === fold(match.player2);
  const reversed = fold(saved.player1) === fold(match.player2) && fold(saved.player2) === fold(match.player1);
  if (!same && !reversed)
    return {
      matchId: match.id,
      finished: true,
      history: [],
      historyIssue: 'Les tireurs du déroulé live ne correspondent plus à cette rencontre.',
    };
  const history = reversed
    ? saved.history.map((t) => ({
        ...t,
        score1: t.score2,
        score2: t.score1,
        by: t.by === 1 ? 2 : t.by === 2 ? 1 : t.by,
      }))
    : saved.history;
  const last = history.at(-1);
  // Une diffusion live peut être partielle ou corrigée. Ne jamais déduire une inversion des seuls scores.
  if (
    Number.isInteger(match.score1) &&
    Number.isInteger(match.score2) &&
    (last.score1 > match.score1 || last.score2 > match.score2)
  ) {
    return {
      matchId: match.id,
      finished: true,
      history: [],
      historyIssue:
        'Le déroulé live ne correspond pas au résultat officiel ; il est masqué pour éviter une attribution erronée des touches.',
    };
  }
  return { matchId: match.id, finished: true, history };
}

// Associe les pistes actives aux rencontres non terminées, par les deux noms (ordre indifférent),
// et remet le score dans l'ordre player1 / player2. Les rencontres terminées gardent leur déroulé.
function matchLive(matches, states, now = Date.now()) {
  const out = [];
  for (const m of matches) {
    if (m.isFinished) {
      const saved = retainedHistory(m);
      if (saved) out.push(saved);
      continue;
    }
    const a = fold(m.player1),
      b = fold(m.player2);
    // Par équipes, FTL transmet les tireurs du relais, pas le nom des équipes.
    // La piste ET les deux pays officiels doivent correspondre sans ambiguïté.
    const team = m.podiumFormat === 'TEAM';
    const c1 = m.player1Country,
      c2 = m.player2Country;
    const candidates = states.filter((x) => {
      if (now - x.at > FRESH_MS || !x.left.name || !x.right.name) return false;
      if (!team)
        return (
          (fold(x.left.name) === a && fold(x.right.name) === b) || (fold(x.left.name) === b && fold(x.right.name) === a)
        );
      if (!m.strip || fold(m.strip) !== fold(x.strip) || !c1 || !c2 || c1 === c2) return false;
      return (
        (countryFor([{ name: x.left.name, country: x.left.country }], x.left.name) === c1 &&
          countryFor([{ name: x.right.name, country: x.right.country }], x.right.name) === c2) ||
        (countryFor([{ name: x.left.name, country: x.left.country }], x.left.name) === c2 &&
          countryFor([{ name: x.right.name, country: x.right.country }], x.right.name) === c1)
      );
    });
    if (candidates.length !== 1) continue;
    const s = candidates[0];
    if (
      team &&
      matches.filter(
        (other) =>
          !other.isFinished &&
          other.podiumFormat === 'TEAM' &&
          fold(other.strip) === fold(m.strip) &&
          ((other.player1Country === c1 && other.player2Country === c2) ||
            (other.player1Country === c2 && other.player2Country === c1)),
      ).length !== 1
    )
      continue;
    const swap = team
      ? countryFor([{ name: s.left.name, country: s.left.country }], s.left.name) !== c1
      : fold(s.left.name) !== a;
    if (!team) {
      const sameFencers = matches.filter(
        (other) =>
          !other.isFinished &&
          ((fold(other.player1) === a && fold(other.player2) === b) ||
            (fold(other.player1) === b && fold(other.player2) === a)),
      );
      if (sameFencers.length > 1) {
        const onStrip = sameFencers.filter((other) => other.strip && fold(other.strip) === fold(s.strip));
        if (onStrip.length !== 1 || onStrip[0].id !== m.id) continue;
      }
    }
    // FTL peut afficher l’affiche bien avant le combat, à 0–0 / 3:00.
    // Une horloge entamée (ou une période ultérieure) prouve le début ;
    // 0:00 sans score peut être une piste initialisée, pas un départ.
    const clockStarted =
      (Number.isFinite(s.clock) && s.clock > 0 && s.clock < 180) ||
      (s.clock === 0 && (s.left.score > 0 || s.right.score > 0)) ||
      s.period > 1;
    if (clockStarted) rememberLive(m, s.at);
    const started = Boolean(liveDetectedAt(m));
    const [p1, p2] = swap ? [s.right, s.left] : [s.left, s.right];
    const history = oriented(bouts.get(boutKey(s))?.touches || [], swap);
    if (history.length) finishedHistory.set(m.id, { player1: m.player1, player2: m.player2, history });
    out.push({
      matchId: m.id,
      ftlLeftPlayer: swap ? 2 : 1,
      finished: false,
      started,
      strip: s.strip,
      clock: s.clock,
      period: s.period,
      score1: p1.score,
      score2: p2.score,
      fencer1: p1,
      fencer2: p2,
      history,
      updatedAt: new Date(s.at).toISOString(),
    });
  }
  return out;
}

async function refreshTracked(db) {
  const list = await db.tournament.findMany({
    where: { archivedAt: null, ftlSourceUrl: { not: null } },
    select: { ftlSourceUrl: true, competitions: { select: { id: true } } },
  });
  tracked = new Set(list.map((t) => GUID.exec(t.ftlSourceUrl || '')?.[1]?.toUpperCase()).filter(Boolean));
  trackedCompetitions = new Map(
    list.map((t) => [GUID.exec(t.ftlSourceUrl || '')?.[1]?.toUpperCase(), (t.competitions || []).map((c) => c.id)]),
  );
}

// Rencontres de l'épreuve et identifiant FencingTimeLive du tournoi (gardés quelques secondes).
async function competitionContext(db, competitionId, now = Date.now()) {
  const cached = matchesCache.get(competitionId);
  if (cached && now - cached.at < MATCHES_MS) return cached;
  const competition = await db.competition.findUnique({
    where: { id: competitionId },
    select: { podiumFormat: true, podiumRoster: true, tournament: { select: { ftlSourceUrl: true } } },
  });
  const guid = GUID.exec(competition?.tournament?.ftlSourceUrl || '')?.[1]?.toUpperCase() || null;
  const matches = guid
    ? await db.match.findMany({
        where: { competitionId },
        select: {
          id: true,
          player1: true,
          player2: true,
          isFinished: true,
          strip: true,
          liveDetectedAt: true,
          score1: true,
          score2: true,
        },
      })
    : [];
  const enriched = matches.map((match) => ({
    ...match,
    podiumFormat: competition?.podiumFormat,
    player1Country: countryFor(competition?.podiumRoster, match.player1),
    player2Country: countryFor(competition?.podiumRoster, match.player2),
  }));
  const context = { at: now, guid, matches: enriched };
  matchesCache.set(competitionId, context);
  return context;
}

async function liveFor(db, competitionId, now = Date.now()) {
  const { guid, matches } = await competitionContext(db, competitionId, now);
  if (!guid) return [];
  const states = [...strips.values()].filter((s) => s.guid === guid);
  return matchLive(matches, states, now);
}

// Toutes les pistes des épreuves par équipes du même tournoi. Lecture uniquement.
const teamContexts = new Map();
async function teamOverviewFor(db, competitionId, now = Date.now()) {
  let context = teamContexts.get(competitionId);
  if (!context || now - context.at >= MATCHES_MS) {
    const selected = await db.competition.findUnique({
      where: { id: competitionId },
      select: { tournamentId: true, podiumFormat: true, tournament: { select: { ftlSourceUrl: true } } },
    });
    const guid = GUID.exec(selected?.tournament?.ftlSourceUrl || '')?.[1]?.toUpperCase();
    if (!guid || selected.podiumFormat !== 'TEAM') return [];
    const competitions = await db.competition.findMany({
      where: { tournamentId: selected.tournamentId, podiumFormat: 'TEAM' },
      select: { id: true, tournamentId: true, name: true, podiumFormat: true, podiumRoster: true },
    });
    const matches = await db.match.findMany({
      where: { competitionId: { in: competitions.map((c) => c.id) } },
      select: {
        id: true,
        competitionId: true,
        player1: true,
        player2: true,
        strip: true,
        round: true,
        isFinished: true,
      },
    });
    context = { at: now, guid, competitions, matches };
    teamContexts.set(competitionId, context);
    if (teamContexts.size > 200) teamContexts.delete(teamContexts.keys().next().value);
  }
  return require('./teamLiveOverview').teamLiveRows(
    context.competitions,
    context.matches,
    [...strips.values()].filter((state) => state.guid === context.guid),
    now,
    FRESH_MS,
  );
}

// Exécuté par le worker, même sans écran ouvert. Les mises à jour conditionnelles prennent
// le même verrou de ligne PostgreSQL que l’enregistrement d’un pronostic.
async function persistLiveLocks(db, competitionId, now = Date.now()) {
  const { matches } = await competitionContext(db, competitionId, now);
  await liveFor(db, competitionId, now);
  for (const match of matches) {
    const detected = liveDetectedAt(match);
    if (!detected || match.liveDetectedAt || match.isFinished) continue;
    const saved = await db.match.updateMany({
      where: { id: match.id, player1: match.player1, player2: match.player2, isFinished: false, liveDetectedAt: null },
      data: { liveDetectedAt: new Date(detected) },
    });
    if (saved.count) match.liveDetectedAt = new Date(detected);
  }
}

// Abonnement d'un écran : appelé à chaque changement sur une piste du tournoi de l'épreuve.
async function subscribe(db, competitionId, onChange) {
  const { guid } = await competitionContext(db, competitionId);
  if (!guid) return () => {};
  const listener = (changed) => {
    if (changed === guid) onChange();
  };
  events.on('change', listener);
  return () => events.off('change', listener);
}

function startWorker(db, { connect = (url, opts) => require('socket.io-client').io(url, opts) } = {}) {
  if (process.env.FTL_AUTO_SYNC !== 'true' || process.env.FTL_LIVE_SCORES === 'false') return () => {};
  let socket = null;
  const refresh = () => refreshTracked(db).catch(() => {});
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();
  socket = connect(`${ORIGIN}/livescores`, { transports: ['websocket'], reconnectionDelayMax: 30000 });
  const running = new Map();
  let stopped = false;
  const schedule = (id) => {
    const state = running.get(id);
    if (state) {
      state.again = true;
      return;
    }
    const next = { again: false };
    running.set(id, next);
    persistLiveLocks(db, id)
      .catch((error) => {
        console.error('Verrouillage des pronostics live indisponible :', error.message);
      })
      .finally(() => {
        running.delete(id);
        if (next.again && !stopped) schedule(id);
      });
  };
  socket.on('change', (message) => {
    const state = record(message);
    if (state) for (const id of trackedCompetitions.get(state.guid) || []) schedule(id);
  });
  console.log('Scores en direct FencingTimeLive : écoute des pistes active.');
  return () => {
    stopped = true;
    clearInterval(timer);
    socket?.close();
  };
}

module.exports = {
  persistLiveLocks,
  startWorker,
  liveFor,
  teamOverviewFor,
  subscribe,
  matchLive,
  record,
  FRESH_MS,
  _strips: strips,
  _bouts: bouts,
};
