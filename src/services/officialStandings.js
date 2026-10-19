// Consultation sportive en lecture seule : aucune écriture de résultat, de pronostic ou de points.
const E = require('./engardeParser');
const { entryFor } = require('./engardeRoster');
const { createEngardeClient } = require('./engardeTournament');
const cache = new Map();
const pending = new Map();
const MAX_CACHE = 100;
function finalStanding(c) {
  if (!c.resultsVerifiedAt || !c.officialPodium?.finalConfirmed) return null;
  const entries = c.officialPodium.classification;
  if (!Array.isArray(entries) || !entries.length) return null;
  const rows = entries.flatMap((r) => {
    const entry = c.podiumRoster?.find((e) => String(e.id) === String(r.entryId));
    return entry
      ? [
          {
            entryId: String(entry.id),
            place: String(r.rank),
            name: entry.name,
            club: entry.club || entry.country || '',
            tied: Boolean(r.tied),
            stats: {},
          },
        ]
      : [];
  });
  return rows.length
    ? {
        key: 'final',
        label: 'Classement final',
        kind: 'final',
        rows,
        sourceUrl: c.resultsSourceUrl,
        checkedAt: c.resultsVerifiedAt,
        stale: false,
      }
    : null;
}
function safeSource(url) {
  const link = E.parseLink(url);
  return link?.kind === 'competition' ? link : null;
}
async function readIntermediate(c, pools, client) {
  const stages = new Map();
  for (const pool of pools) {
    const link = safeSource(pool.sourceUrl);
    if (!link) continue;
    const base = `${E.ORIGIN}/competition/${link.org}/${link.event}/${link.compe}`;
    if (!stages.has(base)) stages.set(base, { link, pools: [] });
    stages.get(base).pools.push(pool);
  }
  const standings = [],
    warnings = [];
  if (stages.size > 8) throw new Error('Trop de sessions officielles pour cette épreuve.');
  for (const [base, stage] of stages) {
    try {
      const pages = E.competitionPages(await client.get(base), stage.link);
      if (pages.rankings.length > 12) throw new Error('Trop de tours officiels.');
      for (const url of pages.rankings) {
        try {
          const n = Number(/claspoules(\d+)\.htm$/.exec(url)[1]);
          const pool = stage.pools.find((p) => p.sourceUrl.endsWith(`/poules${n}.htm`));
          // Une page étrangère à un tour déjà rattaché n'est pas associée par supposition.
          if (!pool) continue;
          const round = Number(/^Tour (\d+)/.exec(pool.name)?.[1] || n);
          const day = /· (J\d+) ·/.exec(pool.name)?.[1];
          const rows = E.parsePoolRanking(await client.get(url)).map((r) => {
            const entry = entryFor(c.podiumRoster || [], r.name, r.club);
            if (!entry) throw new Error('Identité du classement à vérifier.');
            return { ...r, entryId: String(entry.id) };
          });
          if (new Set(rows.map((r) => r.entryId)).size !== rows.length)
            throw new Error('Identité répétée dans le classement.');
          standings.push({
            key: url,
            label: `Après le tour ${round} de poules${day ? ` · ${day}` : ''}`,
            kind: 'pools',
            round,
            rows,
            sourceUrl: url,
            checkedAt: new Date().toISOString(),
            stale: false,
          });
        } catch {
          warnings.push(`Un classement après les poules n’a pas pu être vérifié pour cette session.`);
        }
      }
    } catch {
      warnings.push('Les classements intermédiaires officiels sont momentanément indisponibles.');
    }
  }
  return { standings: standings.sort((a, b) => a.round - b.round), warnings: [...new Set(warnings)] };
}
async function officialStandings(db, competitionId, { clientFactory = createEngardeClient, now = Date.now() } = {}) {
  const c = await db.competition.findUnique({
    where: { id: competitionId },
    select: {
      id: true,
      podiumRoster: true,
      officialPodium: true,
      resultsSourceUrl: true,
      resultsVerifiedAt: true,
    },
  });
  if (!c) throw Object.assign(new Error('Épreuve introuvable.'), { status: 404 });
  const pools = await db.pool.findMany({
    where: { competitionId },
    orderBy: { id: 'asc' },
    select: { name: true, sourceUrl: true },
  });
  const signature = JSON.stringify([pools, c.podiumRoster]);
  const cached = cache.get(competitionId);
  let intermediate;
  if (cached?.signature === signature && cached.expiresAt > now) intermediate = cached.value;
  else {
    const key = `${competitionId}:${signature}`;
    if (!pending.has(key))
      pending.set(
        key,
        readIntermediate(c, pools, clientFactory())
          .then((value) => {
            // Une panne ne remplace pas une lecture précédemment vérifiée par un vide trompeur.
            const previous = cached?.signature === signature ? cached.value.standings : [];
            const fresh = new Set(value.standings.map((s) => s.key));
            value.standings.push(...previous.filter((s) => !fresh.has(s.key)).map((s) => ({ ...s, stale: true })));
            value.standings.sort((a, b) => a.round - b.round);
            if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
            cache.set(competitionId, {
              signature,
              value,
              expiresAt: now + (value.warnings.length ? 60000 : c.officialPodium?.finalConfirmed ? 3600000 : 300000),
            });
            return value;
          })
          .finally(() => pending.delete(key)),
      );
    intermediate = await pending.get(key);
  }
  const final = finalStanding(c);
  return {
    competitionId,
    standings: [...(final ? [final] : []), ...intermediate.standings],
    warnings: intermediate.warnings,
  };
}
module.exports = { officialStandings, finalStanding, readIntermediate };
