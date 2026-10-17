// Organisation confirmée : plusieurs tours qualificatifs, puis une nouvelle publication pour l'épreuve nationale.
// Les URL de sessions viennent exclusivement de la liste officielle du tournoi, jamais de suffixes devinés.
const E = require('./engardeParser');
const { norm } = require('./ftlParser');
const DATA = require('../data/calendar.json');
function profile(config) {
  const source = `${E.ORIGIN}/tournament/${config.org}/${config.tournamentSlug}`;
  const entry = DATA.events.find((e) => e.officialSourceUrl === source && e.poolStages);
  if (!entry) return null;
  const gender = require('./calendarWatch').classify(config.event).gender;
  const rounds = entry.poolStages.qualificationRounds[gender];
  return rounds ? { ...entry.poolStages, rounds, calendarId: entry.id, source } : null;
}
// Certains organisateurs dupliquent une fiche sans corriger le champ sexe.
// Pour les formules multi-journées validées, un titre explicite et concordant
// sur l'arme et la catégorie départage les sessions ; aucune URL n'est déduite.
function sessionIdentity(event) {
  if (!profile(event) || !event.title) return event;
  const classify = require('./calendarWatch').classify;
  const title = classify(event.title),
    structured = classify(event.event);
  const genders = ['Dames', 'Hommes', 'Mixte'];
  const explicit = genders.filter((gender) => new RegExp(`\\b${gender}\\b`, 'i').test(event.title));
  if (
    explicit.length !== 1 ||
    !title.weapon ||
    title.weapon !== structured.weapon ||
    !title.category ||
    title.category !== structured.category
  )
    return event;
  const gender = explicit[0];
  return { ...event, gender, event: event.event.replace(/\b(Dames|Hommes|Mixte)\b/i, gender) };
}
function sessions(config, published) {
  const plan = profile(config);
  if (!plan) return null;
  const same = published
    .map(sessionIdentity)
    .filter((e) => norm(e.event) === norm(config.event) && e.format === config.format);
  const at = (date) => same.filter((e) => e.date === date);
  const qualification = at(plan.qualificationDate),
    main = at(plan.mainDate);
  if (qualification.length !== 1 || main.length > 1)
    throw new E.EngardeError('Journées engarde ambiguës : sources et pronostics conservés, vérification requise.');
  return [
    { ...qualification[0], role: 'qualification', roundOffset: 0, poolRounds: plan.rounds },
    ...main.map((e) => ({ ...e, role: 'main', roundOffset: plan.rounds, poolRounds: plan.mainRounds })),
  ];
}
function canonicalEvents(events) {
  events = events.map(sessionIdentity);
  return events.filter((event) => {
    const plan = profile(event);
    if (!plan || event.date !== plan.mainDate) return true;
    const anchors = events.filter(
      (e) => e.date === plan.qualificationDate && norm(e.event) === norm(event.event) && e.format === event.format,
    );
    if (anchors.length !== 1)
      throw new E.EngardeError('Qualification du samedi ambiguë : épreuve du dimanche non fusionnée.');
    return false;
  });
}
const cache = new WeakMap();
async function discover(config, client) {
  const key = client;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > 5 * 60000) {
    const rows = E.parseCompetitions(await client.competitions(config.org, config.tournamentSlug), {
      org: config.org,
      event: config.tournamentSlug,
    });
    entry = { at: Date.now(), rows };
    cache.set(key, entry);
  }
  return sessions(config, entry.rows);
}
async function control(db, c, config, actorId, claim, client) {
  const published = await discover(config, client);
  const results = [];
  if (published[0].compe !== config.compe) {
    const session = published[0];
    config = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
      const previous = await require('./ftlConfiguration').configuration(tx, c.id);
      if (!require('node:util').isDeepStrictEqual(previous, config))
        throw new E.EngardeError('Configuration modifiée pendant le contrôle.');
      const [pools, matches] = await Promise.all([
        tx.pool.count({ where: { competitionId: c.id } }),
        tx.match.count({ where: { competitionId: c.id } }),
      ]);
      if (pools || matches)
        throw new E.EngardeError(
          'Source officielle déplacée après import sportif : rapprochement à vérifier, données conservées.',
        );
      const eventId = `${session.org}/${session.tournamentSlug}/${session.compe}`;
      const existing = await tx.competition.findUnique({ where: { ftlEventId: `ENGARDE:${eventId}` } });
      if (existing && existing.id !== c.id)
        throw new E.EngardeError('Nouvelle source déjà utilisée par une autre compétition.');
      const next = { ...config, compe: session.compe, eventId, eventSourceUrl: session.eventSourceUrl };
      await tx.competition.update({ where: { id: c.id }, data: { ftlEventId: `ENGARDE:${eventId}` } });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'Configuration FTL validée',
          targetType: 'Competition',
          targetId: c.id,
          before: config,
          after: next,
        },
      });
      return next;
    });
  }
  for (const session of published) {
    const eventId = `ENGARDE:${session.org}/${session.tournamentSlug}/${session.compe}`;
    const existing = await db.competition.findUnique({ where: { ftlEventId: eventId } });
    if (existing && existing.id !== c.id)
      throw new E.EngardeError(
        'La journée est déjà importée dans une autre compétition : rapprochement manuel requis, aucun doublon créé.',
      );
  }
  for (const session of published) {
    const sessionConfig = {
      ...config,
      date: session.date,
      time: session.time,
      compe: session.compe,
      eventId: `${session.org}/${session.tournamentSlug}/${session.compe}`,
      eventSourceUrl: session.eventSourceUrl,
      _stage: session,
    };
    const result = await require('./engardeSync').control(db, c, sessionConfig, actorId, claim, client);
    c = result.c;
    results.push(result);
  }
  const poolSummary = { checked: 0, locks: 0, finalized: 0, changed: 0, pointsUpdated: 0, warnings: [], notes: [] };
  const summary = {
    createdIds: [],
    created: 0,
    results: 0,
    corrections: 0,
    pointsUpdated: 0,
    podium: false,
    checked: 0,
    warnings: [],
    notes: [],
  };
  for (const r of results) {
    for (const k of ['checked', 'locks', 'finalized', 'changed', 'pointsUpdated'])
      poolSummary[k] += r.poolSummary[k] || 0;
    poolSummary.warnings.push(...(r.poolSummary.warnings || []));
    poolSummary.notes.push(...(r.poolSummary.notes || []));
    for (const k of ['created', 'results', 'corrections', 'pointsUpdated', 'checked']) summary[k] += r.summary[k] || 0;
    summary.createdIds.push(...(r.summary.createdIds || []));
    summary.warnings.push(...(r.summary.warnings || []));
    summary.notes.push(...(r.summary.notes || []));
    summary.podium ||= r.summary.podium;
  }
  if (!published.some((s) => s.role === 'main'))
    summary.notes.push('Épreuve du dimanche en attente de publication officielle ; suivi maintenu.');
  return { c, poolSummary, summary };
}
async function existingAnchor(db, event) {
  const plan = profile(event);
  if (!plan || event.date !== plan.qualificationDate) return null;
  const candidates = await db.competition.findMany({
    where: { name: { equals: event.event, mode: 'insensitive' }, tournament: { ftlSourceUrl: plan.source } },
    select: { id: true, ftlEventId: true },
  });
  const mine = candidates.filter((c) => c.ftlEventId?.startsWith(`ENGARDE:${event.org}/${event.tournamentSlug}/`));
  if (mine.length > 1)
    throw new E.EngardeError('Plusieurs compétitions existantes pour cette journée : aucun doublon créé.');
  if (!mine.length) return null;
  const config = await require('./ftlConfiguration').configuration(db, mine[0].id);
  if (config?.date !== event.date || norm(config.event) !== norm(event.event) || config.format !== event.format)
    throw new E.EngardeError('Source déplacée non concordante avec la configuration existante.');
  if (config.compe !== event.compe) {
    const [pools, matches] = await Promise.all([
      db.pool.count({ where: { competitionId: mine[0].id } }),
      db.match.count({ where: { competitionId: mine[0].id } }),
    ]);
    if (pools || matches)
      throw new E.EngardeError('Source déplacée après import sportif : aucun nouveau tournoi créé.');
  }
  return mine[0];
}
module.exports = { profile, sessions, canonicalEvents, control, existingAnchor };
