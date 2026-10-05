// Lieu, date et jour de chaque phase d'une épreuve, corrigés par un administrateur. La correction est
// un journal à part (« Lieu et dates corrigés ») fusionné avec la configuration validée : la date d'un
// tour de poules ou de tableau corrigée l'emporte sur la déduction automatique (même jour / lendemain).
const { cleanCity } = require('./venue');
const { failure } = require('./ftlClient');
const { localTime } = require('./localTime');

const CORRECTION = 'Lieu et dates corrigés';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHASE = /^(pools-\d{1,2}|T\d{1,4}|Bronze)$/;
const FIELDS = ['city', 'timezone', 'country', 'date', 'phaseDays'];

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('fr', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
const validDate = (d) => DATE.test(d) && Number.isFinite(Date.parse(`${d}T12:00:00Z`));

// Correction validée (champs absents = inchangés ; chaîne vide ou null = retour à l'automatique).
function validateCorrection(input = {}, previous = {}) {
  const out = { ...previous };
  if ('city' in input) out.city = input.city ? cleanCity(input.city) : null;
  if ('timezone' in input) {
    if (input.timezone && !validTimezone(input.timezone)) throw failure('Fuseau horaire invalide.', 400);
    out.timezone = input.timezone || null;
  }
  if ('country' in input) {
    const c = String(input.country || '').toUpperCase();
    if (c && !/^[A-Z]{2,3}$/.test(c)) throw failure('Code pays invalide.', 400);
    out.country = c || null;
  }
  if ('date' in input) {
    if (input.date && !validDate(input.date)) throw failure('Date invalide (AAAA-MM-JJ).', 400);
    out.date = input.date || null;
  }
  if ('phaseDays' in input) {
    if (typeof input.phaseDays !== 'object' || Array.isArray(input.phaseDays) || input.phaseDays === null)
      throw failure('Jours des phases invalides.', 400);
    const days = { ...(previous.phaseDays || {}) };
    for (const [phase, day] of Object.entries(input.phaseDays)) {
      if (!PHASE.test(phase)) throw failure(`Phase inconnue : ${phase}.`, 400);
      if (!day) delete days[phase];
      else if (!validDate(day)) throw failure(`Date invalide pour ${phase}.`, 400);
      else days[phase] = day;
    }
    out.phaseDays = days;
  }
  return Object.fromEntries(FIELDS.filter((k) => out[k] !== undefined && out[k] !== null).map((k) => [k, out[k]]));
}

// Configuration + correction : les champs corrigés remplacent ceux de la configuration.
function merge(config, correction) {
  if (!config) return config;
  if (!correction) return config;
  const out = { ...config };
  for (const k of FIELDS) if (correction[k] !== undefined) out[k] = correction[k];
  return out;
}

async function correctionOf(db, competitionId, afterId = 0) {
  const row = await db.auditLog.findFirst({
    where: { action: CORRECTION, targetType: 'Competition', targetId: competitionId, id: { gt: afterId } },
    orderBy: { id: 'desc' },
  });
  return row?.after || null;
}

// Jour imposé d'une phase (« pools-2 », « T64 »…), sinon null.
const phaseDay = (config, phase) => (DATE.test(config?.phaseDays?.[phase] || '') ? config.phaseDays[phase] : null);
// Jours d'écart entre deux dates AAAA-MM-JJ.
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

// Même heure locale, autre jour (match d'un tour de tableau dont le jour a été corrigé).
function onDay(at, day, timezone) {
  if (!at || !day || !timezone) return at;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  try {
    return localTime(day, Number(parts.hour), Number(parts.minute), timezone);
  } catch {
    return at;
  }
}

module.exports = { CORRECTION, validateCorrection, merge, correctionOf, phaseDay, daysBetween, onDay, PHASE };

// Phases d'une épreuve (tours de poules, tours de tableau) avec leur jour actuel et le jour imposé.
const LABELS = { T2: 'Finale', T4: 'Demi-finales', T8: 'Quarts de finale', Bronze: 'Match pour la 3e place' };
function localDay(at, timezone) {
  if (!at) return null;
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone || 'Europe/Paris' }).format(new Date(at));
  } catch {
    return null;
  }
}
async function phases(db, competitionId, config) {
  const [pools, rounds, matches] = await Promise.all([
    db.pool.findMany({ where: { competitionId }, select: { name: true, startsAt: true } }),
    db.matchRound.findMany({ where: { competitionId }, select: { round: true } }),
    db.match.findMany({
      where: { competitionId, OR: [{ resultType: null }, { resultType: { not: 'CANCELLED' } }] },
      select: { round: true, startsAt: true },
    }),
  ]);
  const first = (dates) => {
    const t = dates.filter(Boolean).map((d) => new Date(d).getTime());
    return t.length ? new Date(Math.min(...t)) : null;
  };
  const out = [];
  const poolRounds = new Map();
  for (const p of pools) {
    const r = Number(/^Tour (\d+) · /.exec(p.name)?.[1]) || 1;
    poolRounds.set(r, [...(poolRounds.get(r) || []), p.startsAt]);
  }
  for (const [r, dates] of [...poolRounds].sort(([a], [b]) => a - b))
    out.push({ key: `pools-${r}`, label: poolRounds.size > 1 ? `Poules · tour ${r}` : 'Poules', at: first(dates) });
  const size = (r) => (r === 'Bronze' ? 1.5 : Number(r.slice(1)));
  for (const { round } of [...rounds].sort((a, b) => size(b.round) - size(a.round)))
    out.push({
      key: round,
      label: LABELS[round] || `Tableau de ${round.slice(1)}`,
      at: first(matches.filter((m) => m.round === round).map((m) => m.startsAt)),
    });
  return out.map((p) => ({
    ...p,
    day: localDay(p.at, config?.timezone),
    forced: phaseDay(config, p.key),
  }));
}

module.exports.phases = phases;
