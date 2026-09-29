// Nettoyage automatique des données qui ne servent plus (toutes les 6 heures) :
// notifications envoyées ou annulées depuis plus de 30 jours, événements de notification anciens,
// traces de routine des contrôles FencingTimeLive de plus de 14 jours, et anciens instantanés de
// classement (les 2 plus récents par classement sont toujours gardés pour l'évolution des places).
const { reportError } = require('../lib/report');
const { beat } = require('../lib/heartbeat');

const DAY = 86400000;
async function cleanup(db, now = new Date()) {
  const before = (days) => new Date(now.getTime() - days * DAY);
  const deliveries = await db.pushDelivery.deleteMany({
    where: { status: { in: ['SENT', 'CANCELLED', 'FAILED'] }, createdAt: { lt: before(30) } },
  });
  const events = await db.pushEvent.deleteMany({ where: { createdAt: { lt: before(30) } } });
  const routine = await db.auditLog.deleteMany({
    where: { action: { in: ['Contrôle FTL démarré', 'Contrôle FTL terminé'] }, createdAt: { lt: before(14) } },
  });
  const snapshots = await db.$executeRaw`
    DELETE FROM "AuditLog" WHERE id IN (
      SELECT id FROM (
        SELECT id, "createdAt",
          row_number() OVER (PARTITION BY "targetType", "targetId" ORDER BY id DESC) AS rang
        FROM "AuditLog" WHERE action = 'Classement après import'
      ) t
      WHERE t.rang > 2 AND t."createdAt" < ${before(30)}
    )`;
  // Ligue du club des nouveaux tournois (dès que leur horaire est connu).
  let clubLeagues = 0;
  try {
    clubLeagues = (await require('./club').ensureClubLeagues(db, { now })).length;
  } catch (error) {
    reportError(error, 'ligue du club');
  }
  return { deliveries: deliveries.count, events: events.count, routine: routine.count, snapshots, clubLeagues };
}

function startWorker(db, every = 6 * 3600000) {
  let current = null;
  const run = () =>
    (current = cleanup(db)
      .then((done) => {
        beat('maintenance');
        const total = Object.values(done).reduce((a, b) => a + b, 0);
        if (total) console.log(`Nettoyage : ${JSON.stringify(done)}`);
      })
      .catch((error) => reportError(error, 'nettoyage automatique')));
  const first = setTimeout(run, 5 * 60000);
  const timer = setInterval(run, every);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    return current;
  };
}

module.exports = { cleanup, startWorker };
