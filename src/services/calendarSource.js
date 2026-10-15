// Appelé dans la transaction d’import, sous le verrou commun aux deux plateformes.
// Le lien de calendrier et la création du tournoi sont ainsi validés ensemble.
const ACTION = 'Calendrier : tournoi relié';
async function check(tx, calendarId, sourceUrl) {
  if (!calendarId) return null;
  if (!require('../data/calendar.json').events.some((e) => e.id === calendarId))
    throw Object.assign(new Error('Rendez-vous de calendrier inconnu.'), { status: 400 });
  const rows = await tx.auditLog.findMany({
    where: { action: ACTION, targetType: 'CalendarEvent', after: { path: ['calendarId'], equals: calendarId } },
    orderBy: { id: 'desc' },
    select: { after: true },
  });
  const links = rows.map((r) => r.after).filter((r) => r?.calendarId === calendarId);
  if (links.some((r) => r.sourceUrl !== sourceUrl) || new Set(links.map((r) => r.tournamentId)).size > 1)
    throw Object.assign(
      new Error(
        'Ce rendez-vous est déjà relié à une autre publication officielle. Rapprochement à vérifier dans l’administration ; aucun doublon créé.',
      ),
      { status: 409 },
    );
  return links[0] || null;
}
async function bind(tx, calendarId, sourceUrl, tournamentId, actorId, previous) {
  if (!calendarId) return;
  if (previous && previous.tournamentId !== tournamentId)
    throw Object.assign(new Error('Le tournoi du calendrier a changé. Vérification requise.'), { status: 409 });
  if (previous) return;
  await tx.auditLog.create({
    data: {
      actorId,
      action: ACTION,
      targetType: 'CalendarEvent',
      targetId: tournamentId,
      after: { calendarId, tournamentId, sourceUrl },
    },
  });
}
module.exports = { check, bind };
