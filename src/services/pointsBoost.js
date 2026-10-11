// Points ×2 : l'administration double les points d'une épreuve entière, d'une phase (poules, tableau,
// podium) ou d'un seul tour du tableau, ou de toutes les épreuves d'un tournoi.
// Règle : le doublement vaut à partir de son activation. Seuls les pronostics encore ouverts à ce moment
// (et ceux créés ensuite dans la portée) en profitent ; ce qui était déjà clos garde ses points normaux.
// Le coefficient est figé sur chaque élément (Match, Pool, Competition.podiumMultiplier) : le retrait
// du doublement ne change plus rien à un élément déjà clos.
const { fail } = require('./poolRules');
const { matchClosed, podiumClosed } = require('../lib/matchLock');
const { timedMatches } = require('./roundTiming');
const { reportError } = require('../lib/report');

const BOOST = 2;
const SCOPES = {
  EVENT: 'Toute l’épreuve',
  POOLS: 'Les poules',
  TABLEAU: 'Le tableau',
  ROUND: 'Un tour du tableau',
  PODIUM: 'Le podium',
};
const KIND = 'BOOST';
const ROUND = /^T(?:[2-9]|[1-9]\d{1,3})$/;

const boostsOf = (c) => (Array.isArray(c?.pointsBoosts) ? c.pointsBoosts.filter((b) => b && SCOPES[b.scope]) : []);
const keyOf = (scope, round = null) => (scope === 'ROUND' ? `ROUND:${round}` : scope);

function covers(boost, kind, round = null) {
  switch (boost.scope) {
    case 'EVENT':
      return true;
    case 'POOLS':
      return kind === 'POOL';
    case 'TABLEAU':
      return kind === 'MATCH';
    case 'ROUND':
      return kind === 'MATCH' && boost.round === round;
    case 'PODIUM':
      return kind === 'PODIUM';
    default:
      return false;
  }
}
// Coefficient d'un nouvel élément (kind : MATCH, POOL ou PODIUM) selon les doublements actifs.
const multiplierFor = (c, kind, round = null) => (boostsOf(c).some((b) => covers(b, kind, round)) ? BOOST : 1);

// Libellé court pour l'affichage et les notifications.
const roundName = (round) =>
  ({ T2: 'finale', T4: 'demi-finales', T8: 'quarts de finale' })[round] || `tableau de ${round.slice(1)}`;
function boostLabel(boost) {
  if (boost.scope === 'ROUND') return `ce tour (${roundName(boost.round)})`;
  return { EVENT: 'toute l’épreuve', POOLS: 'les poules', TABLEAU: 'le tableau', PODIUM: 'le podium' }[boost.scope];
}

// Pose le coefficient en vigueur sur tout ce qui est encore ouvert aux pronostics.
async function restamp(tx, c) {
  const matches = await timedMatches(tx, await tx.match.findMany({ where: { competitionId: c.id } }));
  const changed = { matches: 0, pools: 0, podium: false };
  for (const m of matches) {
    if (m.resultType === 'CANCELLED' || matchClosed(m)) continue;
    const want = multiplierFor(c, 'MATCH', m.round);
    if ((m.pointsMultiplier || 1) === want) continue;
    await tx.match.update({ where: { id: m.id }, data: { pointsMultiplier: want } });
    changed.matches++;
  }
  const { closed } = require('./poolRules');
  const pools = await tx.pool.findMany({ where: { competitionId: c.id }, include: { fencers: true } });
  for (const pool of pools) {
    if (closed(pool) || pool.fencers.some((f) => f.firstResultAt)) continue;
    const want = multiplierFor(c, 'POOL');
    if ((pool.pointsMultiplier || 1) === want) continue;
    await tx.pool.update({ where: { id: pool.id }, data: { pointsMultiplier: want } });
    changed.pools++;
  }
  const podium = multiplierFor(c, 'PODIUM');
  if (!podiumClosed(c, matches) && (c.podiumMultiplier || 1) !== podium) {
    await tx.competition.update({ where: { id: c.id }, data: { podiumMultiplier: podium } });
    changed.podium = true;
  }
  return changed;
}

function validate(scope, round) {
  if (!SCOPES[scope]) fail('Portée du doublement inconnue.');
  if (scope === 'ROUND' && (typeof round !== 'string' || !ROUND.test(round))) fail('Choisissez un tour du tableau.');
  return { scope, round: scope === 'ROUND' ? round : null };
}

async function lockedCompetition(tx, competitionId) {
  await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
  const c = await tx.competition.findUnique({ where: { id: competitionId } });
  if (!c) fail('Épreuve introuvable.', 404);
  return c;
}

async function setBoosts(tx, c, boosts, actorId, action, detail) {
  const next = { ...c, pointsBoosts: boosts };
  await tx.competition.update({ where: { id: c.id }, data: { pointsBoosts: boosts.length ? boosts : null } });
  const stamped = await restamp(tx, next);
  await tx.auditLog.create({
    data: {
      actorId,
      action,
      targetType: 'Competition',
      targetId: c.id,
      before: { boosts: boostsOf(c) },
      after: { ...detail, stamped },
    },
  });
  return stamped;
}

async function addBoost(tx, competitionId, input, actorId, extra = {}) {
  const c = await lockedCompetition(tx, competitionId);
  const key = keyOf(input.scope, input.round);
  const boosts = boostsOf(c);
  if (boosts.some((b) => b.key === key)) return { competition: c, boost: null, stamped: null };
  const boost = { key, ...input, activatedAt: new Date().toISOString(), actorId, ...extra };
  const stamped = await setBoosts(tx, c, [...boosts, boost], actorId, 'Points ×2 activés', { boost });
  return { competition: c, boost, stamped };
}

// Active un doublement sur une épreuve. Renvoie aussi le nombre d'appareils prévenus.
async function activate(db, competitionId, body, actorId) {
  const input = validate(body?.scope, body?.round);
  const out = await db.$transaction((tx) => addBoost(tx, competitionId, input, actorId), { timeout: 30000 });
  if (!out.boost) fail('Ce doublement est déjà actif.', 409);
  const notified = await announce(db, out.competition, out.boost);
  require('./standings').invalidateStandings();
  return { boost: out.boost, stamped: out.stamped, notified };
}

async function removeBoost(tx, competitionId, key, actorId) {
  const c = await lockedCompetition(tx, competitionId);
  const boosts = boostsOf(c);
  const boost = boosts.find((b) => b.key === key);
  if (!boost) return null;
  return setBoosts(
    tx,
    c,
    boosts.filter((b) => b !== boost),
    actorId,
    'Points ×2 retirés',
    { removed: boost },
  );
}

async function deactivate(db, competitionId, key, actorId) {
  const stamped = await db.$transaction((tx) => removeBoost(tx, competitionId, String(key || ''), actorId), {
    timeout: 30000,
  });
  if (!stamped) fail('Ce doublement n’est plus actif.', 404);
  return { stamped };
}

// Tout un tournoi : « toute l'épreuve » sur chacune de ses épreuves, une seule notification par appareil.
async function activateTournament(db, tournamentId, actorId) {
  const tournament = await db.tournament.findUnique({
    where: { id: tournamentId },
    include: { competitions: { select: { id: true }, orderBy: { id: 'asc' } } },
  });
  if (!tournament) fail('Tournoi introuvable.', 404);
  if (!tournament.competitions.length) fail('Ce tournoi n’a pas encore d’épreuve.', 409);
  const activated = [];
  for (const { id } of tournament.competitions) {
    const out = await db.$transaction(
      (tx) => addBoost(tx, id, { scope: 'EVENT', round: null }, actorId, { tournament: true }),
      { timeout: 30000 },
    );
    if (out.boost) activated.push(out);
  }
  if (!activated.length) fail('Les points sont déjà doublés sur tout ce tournoi.', 409);
  const notified = await announce(db, activated[0].competition, activated[0].boost, tournament, activated);
  require('./standings').invalidateStandings();
  return { competitions: activated.length, notified };
}

async function deactivateTournament(db, tournamentId, actorId) {
  const competitions = await db.competition.findMany({ where: { tournamentId }, select: { id: true } });
  let removed = 0;
  for (const { id } of competitions)
    if (await db.$transaction((tx) => removeBoost(tx, id, 'EVENT', actorId), { timeout: 30000 })) removed++;
  if (!removed) fail('Aucun doublement sur l’ensemble du tournoi.', 404);
  return { competitions: removed };
}

// Notification « Profite !! » aux appareils qui suivent l'épreuve (ou le tournoi).
async function announce(db, c, boost, tournament = null, activated = null) {
  try {
    const { followers } = require('./pushNotifications');
    const subs = new Map();
    for (const item of activated || [{ competition: c }])
      for (const s of await followers(db, item.competition)) subs.set(s.id, s);
    if (!subs.size) return 0;
    const round = `${tournament ? `tournament-${tournament.id}` : boost.key}@${Date.parse(boost.activatedAt)}`;
    const created = await db.pushDelivery.createMany({
      data: [...subs.keys()].map((subscriptionId) => ({
        subscriptionId,
        competitionId: c.id,
        throughEventId: 0,
        kind: KIND,
        round,
        matchIds: [],
      })),
      skipDuplicates: true,
    });
    return created.count;
  } catch (e) {
    reportError(e, 'notification points ×2');
    return 0;
  }
}

// Texte de la notification, relu à l'envoi : rien n'est envoyé si le doublement a été retiré entre-temps.
async function boostNotification(db, c, round) {
  const m = /^(.+)@(\d+)$/.exec(round || '');
  if (!m) return null;
  const tournamentId = /^tournament-(\d+)$/.exec(m[1])?.[1];
  const boost = boostsOf(c).find(
    (b) => (tournamentId ? b.scope === 'EVENT' && b.tournament : b.key === m[1]) && Date.parse(b.activatedAt) === +m[2],
  );
  if (!boost) return null;
  if (tournamentId) {
    const t = await db.tournament.findUnique({ where: { id: Number(tournamentId) }, select: { name: true } });
    return {
      title: `🔥 Points ×2 · ${t?.name || c.name}`,
      body: `Profite !! Points doublés sur ${t?.name || c.name} : tous les pronostics encore ouverts comptent double.`,
      url: `/?tournament=${c.tournamentId}`,
    };
  }
  if (boost.scope === 'ROUND' || boost.scope === 'POOLS' || boost.scope === 'TABLEAU' || boost.scope === 'PODIUM')
    return {
      title: `⚡ Points ×2 · ${c.name}`,
      body: `VITE ! Les points sont doublés sur ${boostLabel(boost)} de ${c.name}.`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}${boost.scope === 'POOLS' ? '&view=pools' : boost.scope === 'PODIUM' ? '&view=podium' : ''}`,
    };
  return {
    title: `🔥 Points ×2 · ${c.name}`,
    body: `Profite !! Points doublés sur ${c.name} : tous les pronostics encore ouverts comptent double.`,
    url: `/?tournament=${c.tournamentId}&event=${c.id}`,
  };
}

// Pour l'administration : doublements actifs et tours proposables.
async function overview(db, competitionId) {
  const c = await db.competition.findUnique({ where: { id: competitionId } });
  if (!c) fail('Épreuve introuvable.', 404);
  const [rounds, matches] = await Promise.all([
    db.matchRound.findMany({ where: { competitionId }, select: { round: true } }),
    db.match.findMany({ where: { competitionId }, select: { round: true }, distinct: ['round'] }),
  ]);
  const known = [...new Set([...rounds, ...matches].map((r) => r.round).filter((r) => ROUND.test(r || '')))];
  return {
    competition: { id: c.id, name: c.name, tournamentId: c.tournamentId },
    boosts: boostsOf(c),
    rounds: known.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))),
  };
}

// Champs publics : ce qui est doublé, pour les badges de l'interface.
const publicBoosts = (c) =>
  boostsOf(c).map(({ key, scope, round, activatedAt, tournament }) => ({
    key,
    scope,
    round: round || null,
    activatedAt,
    tournament: Boolean(tournament),
  }));

module.exports = {
  BOOST,
  SCOPES,
  KIND,
  multiplierFor,
  covers,
  keyOf,
  boostsOf,
  publicBoosts,
  restamp,
  activate,
  deactivate,
  activateTournament,
  deactivateTournament,
  announce,
  boostNotification,
  overview,
};
