// Recomposition des poules avant leur début : FencingTimeLive peut modifier des poules déjà publiées
// (forfait, rééquilibrage). Seules les poules réellement modifiées sont remplacées ; les pronostics
// des poules inchangées sont conservés. Les joueurs qui suivent l'épreuve sont prévenus.
const { norm } = require('./ftlParser');
const { failure } = require('./ftlClient');

const ACTION = 'Poules recomposées';
const URGENT_WINDOW = 3 * 3600000;
const sameOrder = (pool, observed) =>
  pool.fencers.length === observed.rows.length &&
  pool.fencers.every(
    (f, i) => f.position === observed.rows[i].position && norm(f.name) === norm(observed.rows[i].name),
  );
const sameFencers = (pool, observed) =>
  pool.fencers.length === observed.rows.length &&
  JSON.stringify(pool.fencers.map((f) => norm(f.name)).sort()) ===
    JSON.stringify(observed.rows.map((r) => norm(r.name)).sort());
const started = (pool) =>
  pool.isLocked ||
  pool.isFinal ||
  pool.fencers.some((f) => f.firstResultAt || f.wins !== null || f.losses !== null || f.indicator !== null);

// Pure : compare les poules enregistrées pour une source et les poules observées.
function planRecomposition(pools, url, observed, roster = [], label = (n) => `Poule ${n}`) {
  const stored = pools.filter((p) => p.sourceUrl === url);
  if (!stored.length) return null; // premier import : géré par l'import normal.
  const byNumber = new Map(stored.map((p) => [p.sourcePoolNumber, p]));
  const seen = new Set(observed.map((o) => o.number));
  const plan = { reordered: [], changed: [], added: [], removed: stored.filter((p) => !seen.has(p.sourcePoolNumber)) };
  for (const o of observed) {
    const p = byNumber.get(o.number);
    if (!p) plan.added.push(o);
    else if (sameOrder(p, o)) continue;
    else if (sameFencers(p, o)) plan.reordered.push({ pool: p, observed: o });
    else plan.changed.push({ pool: p, observed: o });
  }
  if (!plan.reordered.length && !plan.changed.length && !plan.added.length && !plan.removed.length) return null;
  // Une poule commencée dans l'application (résultats déjà importés) n'est jamais réécrite automatiquement.
  // Une poule enregistrée sans aucun résultat peut l'être, même si la poule officielle a commencé : elle
  // n'a jamais eu lieu dans cette composition (tirage refait après forfaits), ses pronostics sont à refaire.
  const touched = [...plan.changed.map((x) => x.pool), ...plan.reordered.map((x) => x.pool), ...plan.removed];
  if (touched.some(started))
    throw failure('Composition des poules modifiée après leur début : vérification manuelle nécessaire.', 409);
  for (const o of [...plan.changed.map((x) => x.observed), ...plan.added])
    for (const r of o.rows)
      if (!r.absent && (roster || []).filter((e) => norm(e.name) === norm(r.name)).length !== 1)
        throw failure(`${label(o.number)} modifiée : tireur absent ou ambigu dans les engagés.`, 409);
  const names = new Set(pools.filter((p) => p.sourceUrl !== url).map((p) => p.name));
  if (plan.added.some((o) => names.has(label(o.number))))
    throw failure('Nouvelle poule en conflit avec une poule saisie à la main.', 409);
  plan.label = label;
  return plan;
}

async function applyRecomposition(db, c, url, plan, config, now = new Date()) {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
      // Rien ne doit avoir bougé depuis la lecture : mêmes poules, mêmes tireurs, toujours pas commencées.
      const current = await tx.pool.findMany({
        where: { competitionId: c.id, sourceUrl: url },
        include: { fencers: { orderBy: { position: 'asc' } } },
        orderBy: { id: 'asc' },
      });
      const snapshot = (p) =>
        JSON.stringify([p.id, p.sourcePoolNumber, p.fencers.map((f) => [f.id, f.name, f.position])]);
      for (const p of [...plan.changed.map((x) => x.pool), ...plan.reordered.map((x) => x.pool), ...plan.removed]) {
        const fresh = current.find((x) => x.id === p.id);
        if (!fresh || snapshot(fresh) !== snapshot(p) || started(fresh))
          throw failure('Poules modifiées pendant le contrôle. Nouvelle vérification nécessaire.', 409);
      }
      const clear = async (fencerIds) => {
        const rows = await tx.poolPrediction.findMany({
          where: { fencerId: { in: fencerIds } },
          select: { userId: true },
        });
        await tx.poolPrediction.deleteMany({ where: { fencerId: { in: fencerIds } } });
        return rows;
      };
      const players = new Set();
      let cleared = 0;
      const notified = [];
      // Même tireurs, ordre différent : mêmes adversaires, pronostics conservés.
      for (const { pool, observed } of plan.reordered) {
        for (const f of pool.fencers)
          await tx.poolFencer.update({ where: { id: f.id }, data: { position: -f.position } });
        for (const r of observed.rows) {
          const f = pool.fencers.find((x) => norm(x.name) === norm(r.name));
          await tx.poolFencer.update({ where: { id: f.id }, data: { position: r.position, name: r.name } });
        }
        await tx.pool.update({ where: { id: pool.id }, data: { sourceCheckedAt: now } });
      }
      for (const { pool, observed } of plan.changed) {
        const rows = await clear(pool.fencers.map((f) => f.id));
        rows.forEach((r) => players.add(r.userId));
        cleared += rows.length;
        await tx.poolFencer.deleteMany({ where: { poolId: pool.id } });
        await tx.pool.update({
          where: { id: pool.id },
          data: {
            recomposedAt: now,
            sourceCheckedAt: now,
            fencers: { create: observed.rows.map((r) => ({ name: r.name, position: r.position })) },
          },
        });
        notified.push(pool.id);
      }
      for (const pool of plan.removed) {
        const rows = await clear(pool.fencers.map((f) => f.id));
        rows.forEach((r) => players.add(r.userId));
        cleared += rows.length;
        await tx.poolFencer.deleteMany({ where: { poolId: pool.id } });
        await tx.pool.delete({ where: { id: pool.id } });
      }
      for (const observed of plan.added) {
        const created = await tx.pool.create({
          data: {
            competitionId: c.id,
            name: (plan.label || ((n) => `Poule ${n}`))(observed.number),
            closesAt: new Date(`${config.date}T00:00:00Z`),
            lockMode: 'FIRST_RESULT',
            sourceUrl: url,
            sourcePoolNumber: observed.number,
            sourceCheckedAt: now,
            recomposedAt: now,
            fencers: { create: observed.rows.map((r) => ({ name: r.name, position: r.position })) },
          },
        });
        notified.push(created.id);
      }
      const summary = {
        changed: plan.changed.map((x) => x.pool.name),
        added: plan.added.map((o) => (plan.label || ((n) => `Poule ${n}`))(o.number)),
        removed: plan.removed.map((p) => p.name),
        reordered: plan.reordered.map((x) => x.pool.name),
        predictionsCleared: cleared,
        players: players.size,
      };
      // Épreuve en France modifiée peu avant le début (3 h) : notification prioritaire, même en heures calmes.
      const starts = [...plan.changed.map((x) => x.observed), ...plan.added]
        .map((o) => (o.startsAt ? new Date(o.startsAt).getTime() : null))
        .filter((t) => t !== null && t > now.getTime() - 30 * 60000);
      const soonest = starts.length ? Math.min(...starts) : null;
      const urgent = config?.timezone === 'Europe/Paris' && soonest !== null && soonest - now.getTime() < URGENT_WINDOW;
      if (urgent) summary.urgentStart = new Date(soonest).toISOString();
      const audit = await tx.auditLog.create({
        data: { actorId: 0, action: ACTION, targetType: 'Competition', targetId: c.id, after: summary },
      });
      // Une notification par abonnement qui suit l'épreuve, seulement si des poules sont à refaire.
      if (notified.length || plan.removed.length) {
        const subs = await tx.pushSubscription.findMany({
          where: {
            enabled: true,
            OR: [{ tournamentIds: { has: c.tournamentId } }, { competitionIds: { has: c.id } }],
          },
          select: { id: true },
        });
        for (const s of subs)
          await tx.pushDelivery.create({
            data: {
              subscriptionId: s.id,
              competitionId: c.id,
              throughEventId: 0,
              kind: 'POOLS',
              round: `${urgent ? 'pools-urgent' : 'pools'}-${audit.id}`,
              matchIds: notified,
            },
          });
      }
      return summary;
    },
    { timeout: 30000 },
  );
}

function describe(summary) {
  const parts = [];
  const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} et ${a.at(-1)}` : a[0]);
  if (summary.changed.length) parts.push(`${list(summary.changed)} modifiée${summary.changed.length > 1 ? 's' : ''}`);
  if (summary.added.length) parts.push(`${list(summary.added)} ajoutée${summary.added.length > 1 ? 's' : ''}`);
  if (summary.removed.length) parts.push(`${list(summary.removed)} supprimée${summary.removed.length > 1 ? 's' : ''}`);
  if (summary.reordered.length) parts.push(`ordre revu pour ${list(summary.reordered)} (pronostics conservés)`);
  return `Poules mises à jour depuis FencingTimeLive : ${parts.join(' ; ')}. ${summary.predictionsCleared} pronostic(s) à refaire.`;
}

// Texte de la notification : les poules encore présentes sont nommées, sinon un message général.
function poolsNotification(c, pools, { urgent = false } = {}) {
  const names = pools.map((p) => p.name).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names.at(-1)}` : names[0];
  if (urgent) {
    const start = pools
      .map((p) => p.startsAt && new Date(p.startsAt).getTime())
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    const at = start
      ? new Date(start).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })
      : null;
    return {
      title: `⚠ Poules modifiées · ${c.name}`,
      body: `${names.length ? `${list} ${names.length > 1 ? 'ont' : 'a'} changé` : 'Les poules ont changé'}${at ? `, début à ${at}` : ''} : refaites vos pronostics avant le début.`,
      url: `/?tournament=${c.tournamentId}&event=${c.id}&view=pools`,
    };
  }
  return {
    title: `Poules modifiées · ${c.name}`,
    body: names.length
      ? `${list} ${names.length > 1 ? 'ont' : 'a'} changé sur FencingTimeLive : pronostics à compléter. Vos autres poules sont conservées.`
      : 'La composition des poules a changé sur FencingTimeLive. Vos autres poules sont conservées.',
    url: `/?tournament=${c.tournamentId}&event=${c.id}&view=pools`,
  };
}

module.exports = { planRecomposition, applyRecomposition, describe, poolsNotification, ACTION };
