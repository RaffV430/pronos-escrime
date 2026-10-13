// Scores en direct des pistes FencingTimeLive (flux temps réel « /livescores », sans connexion au compte).
// Affichage seulement : les points restent calculés sur le résultat final confirmé par l'import officiel.
const { EventEmitter } = require('node:events');
const { ORIGIN } = require('./ftlClient');
const { norm } = require('./ftlParser');

const FRESH_MS = 3 * 60000; // une piste muette depuis 3 min n'est plus « en cours »
const REFRESH_MS = 5 * 60000; // relecture des tournois suivis
const MATCHES_MS = 10000; // rencontres d'une épreuve gardées 10 s entre deux diffusions
const MAX_TOUCHES = 150;
const GUID = /\/tournaments\/eventSchedule\/([a-f0-9]{32})$/i;
const strips = new Map(); // `${guid}:${strip}` → dernier état reçu
const bouts = new Map(); // `${guid}:${strip}:${noms}` → déroulé touche par touche
const finishedHistory = new Map(); // matchId → déroulé conservé après la fin (tant que le serveur tourne)
const matchesCache = new Map(); // competitionId → { at, guid, matches }
const events = new EventEmitter();
events.setMaxListeners(500);
let tracked = new Set();

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

// Associe les pistes actives aux rencontres non terminées, par les deux noms (ordre indifférent),
// et remet le score dans l'ordre player1 / player2. Les rencontres terminées gardent leur déroulé.
function matchLive(matches, states, now = Date.now()) {
  const out = [];
  for (const m of matches) {
    if (m.isFinished) {
      const history = finishedHistory.get(m.id);
      if (history?.length) out.push({ matchId: m.id, finished: true, history });
      continue;
    }
    const a = fold(m.player1),
      b = fold(m.player2);
    const s = states.find(
      (x) =>
        now - x.at <= FRESH_MS &&
        x.left.name &&
        x.right.name &&
        ((fold(x.left.name) === a && fold(x.right.name) === b) ||
          (fold(x.left.name) === b && fold(x.right.name) === a)),
    );
    if (!s) continue;
    const swap = fold(s.left.name) !== a;
    const [p1, p2] = swap ? [s.right, s.left] : [s.left, s.right];
    const history = oriented(bouts.get(boutKey(s))?.touches || [], swap);
    if (history.length) finishedHistory.set(m.id, history);
    out.push({
      matchId: m.id,
      finished: false,
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
    select: { ftlSourceUrl: true },
  });
  tracked = new Set(list.map((t) => GUID.exec(t.ftlSourceUrl || '')?.[1]?.toUpperCase()).filter(Boolean));
}

// Rencontres de l'épreuve et identifiant FencingTimeLive du tournoi (gardés quelques secondes).
async function competitionContext(db, competitionId, now = Date.now()) {
  const cached = matchesCache.get(competitionId);
  if (cached && now - cached.at < MATCHES_MS) return cached;
  const competition = await db.competition.findUnique({
    where: { id: competitionId },
    select: { tournament: { select: { ftlSourceUrl: true } } },
  });
  const guid = GUID.exec(competition?.tournament?.ftlSourceUrl || '')?.[1]?.toUpperCase() || null;
  const matches = guid
    ? await db.match.findMany({
        where: { competitionId },
        select: { id: true, player1: true, player2: true, isFinished: true },
      })
    : [];
  const context = { at: now, guid, matches };
  matchesCache.set(competitionId, context);
  return context;
}

async function liveFor(db, competitionId, now = Date.now()) {
  const { guid, matches } = await competitionContext(db, competitionId, now);
  if (!guid) return [];
  const states = [...strips.values()].filter((s) => s.guid === guid);
  return matchLive(matches, states, now);
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
  socket.on('change', (message) => record(message));
  console.log('Scores en direct FencingTimeLive : écoute des pistes active.');
  return () => {
    clearInterval(timer);
    socket?.close();
  };
}

module.exports = { startWorker, liveFor, subscribe, matchLive, record, FRESH_MS, _strips: strips, _bouts: bouts };
