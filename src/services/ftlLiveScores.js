// Scores en direct des pistes FencingTimeLive (flux temps réel « /livescores », sans connexion au compte).
// Affichage seulement : les points restent calculés sur le résultat final confirmé par l'import officiel.
const { ORIGIN } = require('./ftlClient');
const { norm } = require('./ftlParser');

const FRESH_MS = 3 * 60000; // une piste muette depuis 3 min n'est plus « en cours »
const REFRESH_MS = 5 * 60000; // relecture des tournois suivis
const GUID = /\/tournaments\/eventSchedule\/([a-f0-9]{32})$/i;
const strips = new Map(); // `${guid}:${strip}` → dernier état reçu
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
  return state;
}

// Associe les pistes actives aux rencontres non terminées, par les deux noms (ordre indifférent),
// et remet le score dans l'ordre player1 / player2 de la rencontre.
function matchLive(matches, states, now = Date.now()) {
  const out = [];
  for (const m of matches) {
    if (m.isFinished) continue;
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
    const [p1, p2] = fold(s.left.name) === a ? [s.left, s.right] : [s.right, s.left];
    out.push({
      matchId: m.id,
      strip: s.strip,
      clock: s.clock,
      period: s.period,
      score1: p1.score,
      score2: p2.score,
      fencer1: p1,
      fencer2: p2,
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

async function liveFor(db, competitionId, now = Date.now()) {
  const competition = await db.competition.findUnique({
    where: { id: competitionId },
    select: { tournament: { select: { ftlSourceUrl: true } } },
  });
  const guid = GUID.exec(competition?.tournament?.ftlSourceUrl || '')?.[1]?.toUpperCase();
  if (!guid) return [];
  const states = [...strips.values()].filter((s) => s.guid === guid);
  if (!states.length) return [];
  const matches = await db.match.findMany({
    where: { competitionId, isFinished: false },
    select: { id: true, player1: true, player2: true, isFinished: true },
  });
  return matchLive(matches, states, now);
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

module.exports = { startWorker, liveFor, matchLive, record, FRESH_MS, _strips: strips };
