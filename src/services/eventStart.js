// Début de l'épreuve (début des poules) : date et heure indiquées sur FencingTimeLive, heure locale
// du lieu, en millisecondes UTC. Avant ce moment, aucun résultat de poule ne peut exister.
const MAX_OFFSET = 14 * 3600000; // fuseau le plus en avance (UTC+14), si le fuseau est inconnu.
// « 9:00 AM » (calendrier) ou « Saturday, September 26, 2026 9:00 AM » (page de l'épreuve).
function localMinutes(config) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(String(config?.time || config?.eventTime || '').trim());
  if (!m) return 0;
  const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return h * 60 + Number(m[2]);
}
function eventStart(config) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config?.date || '')) return null;
  const midnight = Date.parse(`${config.date}T00:00:00Z`);
  if (!Number.isFinite(midnight)) return null;
  const utc = midnight + localMinutes(config) * 60000;
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(config.offset || '');
  if (!config.timezone && offset)
    return utc - (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60000;
  if (!config.timezone) return utc - MAX_OFFSET;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: config.timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(utc))
        .map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return utc - (local - utc);
  } catch {
    return utc - MAX_OFFSET;
  }
}
async function eventStartFor(db, competitionId) {
  try {
    const competition = await db.competition.findUnique({
      where: { id: competitionId },
      select: { id: true, rosterSourceUrl: true },
    });
    if (!competition) return null;
    return eventStart(await require('./ftlScheduler').configFor(db, competition));
  } catch {
    return null;
  }
}
module.exports = { eventStart, eventStartFor, localMinutes };
