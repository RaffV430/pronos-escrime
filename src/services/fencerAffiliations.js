// Clubs actuels séparés des listes historiques et des clés de favoris.
const { createHash } = require('node:crypto');
const { failure } = require('./ftlClient');
const { identity, normalize, entriesOf } = (() => {
  const f = require('./fencerFollows');
  return {
    ...f,
    entriesOf: (c) => (c.podiumFormat === 'TEAM' ? [] : Array.isArray(c.podiumRoster) ? c.podiumRoster : []),
  };
})();
const key = (name) =>
  normalize(name)
    .replace(/[’'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const hash = (s) => createHash('sha256').update(s).digest('hex');
async function lock(tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(72610409)::text`;
}
function source(value) {
  if (typeof value === 'string' && /^FFE_RANKING:[a-f0-9]{64}:[1-9][0-9]*$/.test(value)) return value;
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      ![
        'www.fencingtimelive.com',
        'fencingtimelive.com',
        'engarde-service.com',
        'www.engarde-service.com',
        'dirigeant.escrime-ffe.fr',
      ].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.hash
    )
      throw Error();
    return u.href;
  } catch {
    throw failure('Source officielle invalide.', 400);
  }
}
function date(value) {
  const d = new Date(value);
  if (!Number.isFinite(+d) || +d > Date.now() + 300000) throw failure('Date d’observation invalide.', 400);
  return d;
}
const text = (v, max = 160) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
async function observe(tx, profile, input, actorId = 0) {
  const club = text(input.club),
    clubCode = text(input.clubCode, 40),
    observedAt = date(input.observedAt),
    sourceUrl = input.sourceUrl === 'MANUAL' ? 'MANUAL' : source(input.sourceUrl);
  if (!club) return profile; // une source vide n’efface jamais une affiliation connue
  const stale = profile.observedAt && observedAt < profile.observedAt;
  const status = stale ? 'STALE' : profile.locked && sourceUrl !== 'MANUAL' ? 'LOCKED' : 'APPLIED';
  const changed = normalize(club) !== normalize(profile.club) || (clubCode && clubCode !== profile.clubCode);
  if (!changed && status === 'APPLIED' && sourceUrl !== 'MANUAL')
    return tx.fencerAffiliation.update({
      where: { id: profile.id },
      data: { observedAt, sourceUrl, ...(clubCode ? { clubCode } : {}) },
    });
  const last = await tx.fencerAffiliationHistory.findFirst({
    where: { affiliationId: profile.id },
    orderBy: { id: 'desc' },
  });
  if (sourceUrl === 'MANUAL' || !last || last.club !== club || last.status !== status || last.sourceUrl !== sourceUrl)
    await tx.fencerAffiliationHistory.create({
      data: {
        affiliationId: profile.id,
        club,
        clubCode,
        sourceUrl,
        observedAt,
        status,
        actorId,
        reason: text(input.reason, 1000),
      },
    });
  if (status !== 'APPLIED') return profile;
  return tx.fencerAffiliation.update({
    where: { id: profile.id },
    data: { club, clubCode, sourceUrl, observedAt, revision: { increment: 1 } },
  });
}
async function ingest(tx, c, observed = c.podiumRoster, sourceUrl = c.rosterSourceUrl, observedAt = new Date()) {
  // Les anciens mocks unitaires n’ont pas les modèles additionnels ; le client Prisma réel les a.
  if (!tx.fencerAffiliation || c.podiumFormat === 'TEAM' || !Array.isArray(observed) || !sourceUrl) return;
  source(sourceUrl);
  await lock(tx);
  for (const entry of observed) {
    if (entry?.id == null || !entry.name) continue;
    const entryId = String(entry.id),
      data = identity(entry),
      nameKey = key(data.name);
    const duplicate = observed.filter((e) => key(e.name) === nameKey).length !== 1;
    let link = await tx.fencerAffiliationEntry.findUnique({
      where: { competitionId_entryId: { competitionId: c.id, entryId } },
      include: { affiliation: true },
    });
    let profile = link?.affiliation;
    if (
      profile &&
      (profile.nameKey !== nameKey || (profile.country && data.country && profile.country !== data.country))
    )
      continue;
    if (!profile && !duplicate && data.country) {
      const candidates = await tx.fencerAffiliation.findMany({
        where: { nameKey, country: data.country, federationVerified: true },
      });
      if (candidates.length === 1) profile = candidates[0];
    }
    if (!profile)
      profile = await tx.fencerAffiliation.upsert({
        where: { identityKey: hash(`entry:${c.id}:${entryId}`) },
        create: { identityKey: hash(`entry:${c.id}:${entryId}`), name: data.name, nameKey, country: data.country },
        update: {},
      });
    if (!link)
      await tx.fencerAffiliationEntry.create({ data: { competitionId: c.id, entryId, affiliationId: profile.id } });
    // Un homonyme peut être indexé, mais son club n’est jamais propagé automatiquement.
    if (!duplicate) await observe(tx, profile, { club: data.club, sourceUrl, observedAt });
  }
}
async function federationImport(db, rows, actorId) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
    throw failure('Lot de 1 à 1 000 affiliations attendu.', 400);
  return db.$transaction(
    async (tx) => {
      await lock(tx);
      const competitions = await tx.competition.findMany({
        select: { id: true, podiumRoster: true, podiumFormat: true },
      });
      const result = { applied: [], unresolved: [] };
      for (const row of rows) {
        const nameKey = key(row.name),
          country = text(row.country).toUpperCase();
        const sourceUrl = source(row.sourceUrl);
        const ranking = sourceUrl.startsWith('FFE_RANKING:');
        if (
          (!ranking && (new URL(sourceUrl).hostname !== 'dirigeant.escrime-ffe.fr' || row.active !== true)) ||
          country !== 'FRA' ||
          row.unique !== true ||
          !text(row.club)
        ) {
          result.unresolved.push({ name: text(row.name), reason: 'Identité fédérale unique à confirmer.' });
          continue;
        }
        const matches = competitions.flatMap((c) =>
          entriesOf(c)
            .filter((e) => key(e.name) === nameKey && identity(e).country === 'FRA')
            .map((e) => ({ c, e })),
        );
        if (
          !matches.length ||
          matches.some(({ c }) => entriesOf(c).filter((e) => key(e.name) === nameKey).length !== 1)
        ) {
          result.unresolved.push({
            name: text(row.name),
            reason: 'Tireur absent ou homonyme dans les listes connues.',
          });
          continue;
        }
        const identityKey = hash(`ffe:${nameKey}:FRA`);
        let profile = await tx.fencerAffiliation.upsert({
          where: { identityKey },
          create: { identityKey, name: text(row.name), nameKey, country: 'FRA', federationVerified: true },
          update: {},
        });
        const existingLinks = await tx.fencerAffiliationEntry.findMany({
          where: { OR: matches.map(({ c, e }) => ({ competitionId: c.id, entryId: String(e.id) })) },
          include: { affiliation: true },
        });
        if (
          existingLinks.some(
            (l) => l.affiliationId !== profile.id && (l.affiliation.locked || l.affiliation.sourceUrl === 'MANUAL'),
          )
        ) {
          result.unresolved.push({
            name: text(row.name),
            reason: 'Correction manuelle existante : rapprochement à valider.',
          });
          continue;
        }
        for (const { c, e } of matches) {
          const existing = await tx.fencerAffiliationEntry.findUnique({
            where: { competitionId_entryId: { competitionId: c.id, entryId: String(e.id) } },
            include: { affiliation: true },
          });
          if (existing && existing.affiliationId !== profile.id && existing.affiliation.locked)
            throw failure('Une correction verrouillée existe : rapprochement manuel requis.', 409);
          await tx.fencerAffiliationEntry.upsert({
            where: { competitionId_entryId: { competitionId: c.id, entryId: String(e.id) } },
            create: { competitionId: c.id, entryId: String(e.id), affiliationId: profile.id },
            update: { affiliationId: profile.id },
          });
        }
        profile = await observe(tx, profile, { ...row, sourceUrl }, actorId);
        result.applied.push({ id: profile.id, name: profile.name, club: profile.club, entries: matches.length });
      }
      await tx.auditLog.create({
        data: { actorId, action: 'FFE_AFFILIATIONS', targetType: 'FencerAffiliation', targetId: 0, after: result },
      });
      return result;
    },
    { timeout: 60000 },
  );
}
async function manual(db, id, input, actorId) {
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof input.locked !== 'boolean' ||
    !Number.isSafeInteger(input.revision) ||
    !text(input.club) ||
    text(input.reason, 1000).length < 5
  )
    throw failure('Club, motif, version et verrouillage attendus.', 400);
  return db.$transaction(async (tx) => {
    await lock(tx);
    let p = await tx.fencerAffiliation.findUnique({ where: { id } });
    if (!p) throw failure('Tireur introuvable.', 404);
    if (p.revision !== input.revision) throw failure('Affiliation modifiée : actualisez avant de corriger.', 409);
    const before = p;
    p = await observe(
      tx,
      p,
      { club: input.club, clubCode: input.clubCode, reason: input.reason, sourceUrl: 'MANUAL', observedAt: new Date() },
      actorId,
    );
    p = await tx.fencerAffiliation.update({
      where: { id },
      data: { locked: input.locked, revision: { increment: 1 } },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'FENCER_AFFILIATION_MANUAL',
        targetType: 'FencerAffiliation',
        targetId: id,
        before,
        after: p,
      },
    });
    return p;
  });
}
async function decorate(db, competitions, favorites = []) {
  if (!db.fencerAffiliationEntry) return { competitions, favorites };
  const ids = [...new Set([...competitions.map((c) => c.id), ...favorites.map((f) => f.originCompetitionId)])];
  const links = await db.fencerAffiliationEntry.findMany({
    where: { competitionId: { in: ids } },
    include: { affiliation: true },
  });
  const map = new Map(links.map((l) => [`${l.competitionId}:${l.entryId}`, l.affiliation]));
  const extra = (id, entryId) => {
    const p = map.get(`${id}:${entryId}`);
    return p ? { affiliationId: p.id, currentClub: p.club, affiliationSource: p.sourceUrl } : {};
  };
  return {
    competitions: competitions.map((c) =>
      c.podiumFormat === 'TEAM' ? c : { ...c, podiumRoster: entriesOf(c).map((e) => ({ ...e, ...extra(c.id, e.id) })) },
    ),
    favorites: favorites.map((f) => ({ ...f, ...extra(f.originCompetitionId, f.originEntryId) })),
  };
}
module.exports = { key, source, observe, ingest, federationImport, manual, decorate };
