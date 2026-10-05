// Nouveau tour de poules (tour 2 et suivants) ouvert aux pronostics : une notification par appareil qui
// suit l'épreuve, une seule fois par tour. Le texte est construit à l'envoi, avec les poules encore ouvertes.
const { reportError } = require('../lib/report');

const PREFIX = 'pools-new-';
const roundOf = (name) => Number(/^Tour (\d+) · /.exec(name || '')?.[1]) || null;
const openPools = { isLocked: false, isFinal: false, lockMode: { not: 'PROVISIONAL' } };

async function alertNewPoolRounds(db, c) {
  try {
    const pools = await db.pool.findMany({
      where: { competitionId: c.id, name: { startsWith: 'Tour ' }, ...openPools },
      select: { id: true, name: true },
    });
    const rounds = new Map();
    for (const p of pools) {
      const r = roundOf(p.name);
      if (r >= 2) rounds.set(r, [...(rounds.get(r) || []), p.id]);
    }
    if (!rounds.size) return 0;
    const subs = await require('./pushNotifications').followers(db, c);
    if (!subs.length) return 0;
    let queued = 0;
    for (const [round, ids] of rounds) {
      const created = await db.pushDelivery.createMany({
        data: subs.map((s) => ({
          subscriptionId: s.id,
          competitionId: c.id,
          throughEventId: 0,
          kind: 'POOLS',
          round: `${PREFIX}${round}`,
          matchIds: ids,
        })),
        skipDuplicates: true,
      });
      queued += created.count;
    }
    return queued;
  } catch (e) {
    reportError(e, 'alerte nouveau tour de poules');
    return 0;
  }
}

const roundOfDelivery = (round) =>
  String(round || '').startsWith(PREFIX) ? Number(String(round).slice(PREFIX.length)) || null : null;

// Poules du tour encore ouvertes au moment de l'envoi.
function poolsOfRound(db, c, round) {
  return db.pool.findMany({
    where: { competitionId: c.id, name: { startsWith: `Tour ${round} · ` }, ...openPools },
    select: { name: true, closesAt: true, lockMode: true },
  });
}

function newRoundNotification(c, round, pools, now = Date.now()) {
  const times = pools
    .filter((p) => p.lockMode === 'START_OR_FIRST_RESULT')
    .map((p) => new Date(p.closesAt).getTime())
    .filter((t) => t > now);
  const at = times.length
    ? new Date(Math.min(...times)).toLocaleTimeString('fr-FR', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  return {
    title: `Tour ${round} de poules · ${c.name}`,
    body: `Les poules du tour ${round} sont publiées : pronostics ouverts ${at ? `jusqu'à ${at}` : "jusqu'au premier résultat"}.`,
    url: `/?tournament=${c.tournamentId}&event=${c.id}&view=pools`,
  };
}

module.exports = { alertNewPoolRounds, roundOfDelivery, poolsOfRound, newRoundNotification, PREFIX };
