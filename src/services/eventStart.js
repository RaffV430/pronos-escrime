// Début de la journée de l'épreuve (minuit, heure locale du lieu), en millisecondes UTC.
// Avant ce moment, aucun résultat de poule ne peut exister : inutile d'exiger un contrôle récent.
const MAX_OFFSET = 14 * 3600000; // fuseau le plus en avance (UTC+14), si le fuseau est inconnu.
function eventStart(config) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config?.date || '')) return null;
  const utc = Date.parse(`${config.date}T00:00:00Z`);
  if (!Number.isFinite(utc)) return null;
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
module.exports = { eventStart, eventStartFor };
