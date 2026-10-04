// Tireur pronostiqué sur un podium qui ne disputera pas le tableau (forfait avant la poule, abandon ou
// exclusion) : les joueurs concernés sont prévenus pour pouvoir changer leur podium avant son blocage
// (premier match du tableau). Une notification par joueur, appareil et tireur.
const { reportError } = require('../lib/report');

const REASONS = { DNS: 'forfait', ABANDON: 'abandon', EXCLUSION: 'exclusion' };
const KIND = 'PODIUM_OUT';

async function alertPodiumOut(db, c, outs) {
  if (!outs.length || c.podiumResolvedAt) return 0;
  try {
    const { podiumClosed } = require('../lib/matchLock');
    if (podiumClosed(c, await db.match.findMany({ where: { competitionId: c.id } }))) return 0;
    const { predictionIds } = require('./podiumRules');
    const predictions = await db.podiumPrediction.findMany({ where: { competitionId: c.id } });
    const users = new Map(); // tireur sorti → joueurs
    for (const p of predictions) {
      let ids;
      try {
        ids = Object.values(predictionIds(c, p));
      } catch {
        continue;
      }
      for (const out of outs) if (ids.includes(out.id)) users.set(out, [...(users.get(out) || []), p.userId]);
    }
    let queued = 0;
    for (const [out, userIds] of users) {
      const subs = await db.pushSubscription.findMany({
        where: { enabled: true, userId: { in: userIds } },
        select: { id: true },
      });
      if (!subs.length) continue;
      const created = await db.pushDelivery.createMany({
        data: subs.map((s) => ({
          subscriptionId: s.id,
          competitionId: c.id,
          throughEventId: 0,
          kind: KIND,
          round: `podium-out-${out.status}-${out.id}`,
          matchIds: [],
        })),
        skipDuplicates: true,
      });
      queued += created.count;
    }
    return queued;
  } catch (e) {
    reportError(e, 'alerte podium');
    return 0;
  }
}

// Texte de la notification, lu à l'envoi (le tireur et la raison viennent de la liste et de la poule).
function podiumOutNotification(c, entry, reason) {
  return {
    title: `⚠ Podium à revoir · ${c.name}`,
    body: `${entry?.name || 'Un tireur de votre podium'} ne disputera pas le tableau${reason ? ` (${reason})` : ''} : vous pouvez changer votre podium jusqu'au début du tableau.`,
    url: `/?tournament=${c.tournamentId}&event=${c.id}&view=podium`,
  };
}

module.exports = { alertPodiumOut, podiumOutNotification, REASONS, KIND };
