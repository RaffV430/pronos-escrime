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
function sessions(config, published) {
  const plan = profile(config);
  if (!plan) return null;
  const same = published.filter((e) => norm(e.event) === norm(config.event) && e.format === config.format);
  const at = (date) => same.filter((e) => e.date === date);
  const qualification = at(plan.qualificationDate),
    main = at(plan.mainDate);
  if (qualification.length !== 1 || main.length > 1 || qualification[0].compe !== config.compe)
    throw new E.EngardeError('Journées engarde ambiguës : sources et pronostics conservés, vérification requise.');
  return [
    { ...qualification[0], role: 'qualification', roundOffset: 0, poolRounds: plan.rounds },
    ...main.map((e) => ({ ...e, role: 'main', roundOffset: plan.rounds, poolRounds: plan.mainRounds })),
  ];
}
function canonicalEvents(events) {
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
module.exports = { profile, sessions, canonicalEvents, control };
