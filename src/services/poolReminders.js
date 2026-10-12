// Rappel des poules : 10 minutes avant la clôture d'un tour de poules, une notification aux joueurs qui
// n'ont pronostiqué aucun tireur dans certaines de ses poules (préférence « Rappels », une fois par tour).
const WINDOW = 600000;
const PREFIX = 'pools-reminder-';
const roundOf = (name) => Number(/^Tour (\d+) · /.exec(name || '')?.[1]) || 1;

// Heure de clôture : l'heure annoncée, ou le début des poules quand elles ferment au premier résultat.
function deadline(pool) {
  const at = pool.lockMode === 'FIRST_RESULT' ? pool.startsAt : pool.closesAt;
  return at ? new Date(at).getTime() : null;
}
function isOpen(pool, now) {
  if (pool.isLocked || pool.isFinal || pool.lockMode === 'PROVISIONAL') return false;
  if ((pool.fencers || []).some((f) => f.firstResultAt)) return false;
  const d = deadline(pool);
  return d !== null && d > now;
}
// Poules sans pronostic du joueur qui ferment dans les 10 minutes, regroupées par tour.
function reminderPlan(pools, predictedPoolIds, now = Date.now()) {
  const saved = new Set(predictedPoolIds);
  const rounds = new Map();
  for (const p of pools) {
    if (!isOpen(p, now) || saved.has(p.id) || deadline(p) - now > WINDOW) continue;
    const r = roundOf(p.name);
    rounds.set(r, [...(rounds.get(r) || []), p]);
  }
  return [...rounds].map(([round, missing]) => ({ round, key: `${PREFIX}${round}`, missing }));
}
// fencers : tireurs suivis (mode « uniquement Mes tireurs ») ; la poule est nommée avec eux.
function reminderText(c, missing, timezone = 'Europe/Paris', fencers = null) {
  const first = Math.min(...missing.map(deadline));
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(first));
  const n = missing.length;
  if (fencers?.length) {
    const { fencerList } = require('./notificationText');
    const mine = missing.flatMap((p) => (p.fencers || []).map((f) => f.name).filter((x) => fencers.includes(x)));
    return {
      title: c.name,
      body:
        n === 1
          ? `${missing[0].name} de ${fencerList(mine)} · pronostic à compléter · clôture vers ${time}`
          : `Poules de ${fencerList(mine)} · ${n} poules à compléter · clôture vers ${time}`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&view=pools`,
    };
  }
  return {
    title: c.name,
    body: `Poules · ${n} poule${n > 1 ? 's' : ''} sans pronostic · clôture vers ${time}`,
    url: `/?tournament=${c.tournamentId}&event=${c.id}&view=pools`,
  };
}
const roundOfDelivery = (key) =>
  String(key || '').startsWith(PREFIX) ? Number(String(key).slice(PREFIX.length)) || null : null;

module.exports = { reminderPlan, reminderText, roundOfDelivery, deadline, isOpen, PREFIX, WINDOW, roundOf };
