// Calendrier des épreuves à venir (sélection FFE validée, src/data/calendar.json) et surveillance
// automatique : dès qu'un tournoi du calendrier apparaît sur FencingTimeLive ou engarde-service, ses
// épreuves de fleuret correspondantes (catégories, hommes / dames, individuel / équipes) sont ajoutées à
// l'application, exactement comme le ferait l'administrateur depuis « Suivi des sites officiels ».
const { reportError } = require('../lib/report');
const { beat } = require('../lib/heartbeat');
const DATA = require('../data/calendar.json');

const DAY = 86400000;
const LINKED = 'Calendrier : tournoi relié';
const WATCHED = 'Calendrier : surveillance';
const AHEAD = 60; // jours : on cherche les tournois qui commencent dans les deux mois
const ACTOR_ACTION = 'Calendrier : ajout automatique';
const rechecked = new Map();

// Noms des villes du calendrier FFE (français) → noms utilisés par les sites officiels.
const ALIASES = {
  livourne: ['livorno'],
  dresde: ['dresden'],
  turin: ['torino'],
  singapour: ['singapore'],
  tachkent: ['tashkent', 'toshkent'],
  palmademajorque: ['palmademallorca', 'palma'],
  saopaulo: ['saopaulo', 'sopaulo'],
  hongkong: ['hongkong'],
  goteborg: ['goteborg', 'gothenburg', 'gteborg'],
  varsovie: ['warsaw', 'warszawa'],
  lima: ['lima'],
  samorin: ['samorin', 'amorn'],
  tbilissi: ['tbilisi'],
  hammamet: ['hammamet'],
  istanbul: ['istanbul'],
  ankara: ['ankara'],
  budapest: ['budapest'],
  shanghai: ['shanghai'],
};
const key = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

function events() {
  return DATA.events;
}

// Ville d'une source (« Etampes, FRA », « HÉNIN-BEAUMONT ») comparée à celle du calendrier.
function sameCity(calendarCity, sourceCity) {
  const a = key(calendarCity),
    b = key(String(sourceCity || '').split(',')[0]);
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  return [a, ...(ALIASES[a] || [])].some((name) => name === b || b.startsWith(name) || name.startsWith(b));
}
const day = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
// Le tournoi officiel recouvre les dates du calendrier (un jour de marge de chaque côté).
function sameDates(entry, from, to = from) {
  const start = day(from),
    end = day(to || from);
  if (!Number.isFinite(start)) return false;
  return start <= day(entry.end) + DAY && end >= day(entry.start) - DAY;
}

// Arme, hommes / dames, catégorie et format d'une épreuve d'après son intitulé officiel.
function classify(text) {
  const t = ` ${String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()} `;
  const weapon = /foil|fleuret|florett|fioretto|florete/.test(t)
    ? 'Fleuret'
    : /epee|spada|degen|espada/.test(t)
      ? 'Épée'
      : /sabre|saber|sciabola|sabel/.test(t)
        ? 'Sabre'
        : null;
  const gender = /women|woman|dames?\b|femmes?|feminin|ladies|girls?|filles?|\bdf\b|\bfd\b|\bwf\b/.test(t)
    ? 'F'
    : /\bmen\b|\bman\b|hommes?|masculin|\bboys?\b|garcons?|\bmf\b|\bfh\b|\bhf\b/.test(t)
      ? 'H'
      : /mixte|mixed/.test(t)
        ? 'X'
        : null;
  const category = /veteran|\bv[1-4]\b|\bv ?cat/.test(t)
    ? 'V'
    : /senior/.test(t)
      ? 'SENIOR'
      : /junior|\bm ?20\b|\bu ?20\b/.test(t)
        ? 'M20'
        : /cadet|\bm ?17\b|\bu ?17\b/.test(t)
          ? 'M17'
          : /minime|\bm ?15\b|\bu ?15\b/.test(t)
            ? 'M15'
            : /benjamin|\bm ?13\b|\bu ?13\b/.test(t)
              ? 'M13'
              : null;
  const team = /equipe|team|squadra|mannschaft/.test(t);
  return { weapon, gender, category, team };
}

// L'épreuve officielle fait-elle partie de l'entrée du calendrier ?
function wanted(entry, officialName) {
  const c = classify(officialName);
  if (c.weapon !== 'Fleuret' || !c.gender || !c.category) return false;
  const genders = entry.gender === 'H' ? ['H'] : entry.gender === 'F' ? ['F'] : ['H', 'F', 'X'];
  if (!genders.includes(c.gender)) return false;
  const categories = entry.categories.map((x) => (x.startsWith('V') ? 'V' : x));
  if (!categories.includes(c.category)) return false;
  if (entry.format === 'INDIVIDUAL' && c.team) return false;
  if (entry.format === 'TEAM' && !c.team) return false;
  return true;
}

// Entrées à surveiller : pas encore terminées, commençant dans les deux mois.
function due(now = Date.now()) {
  return events().filter((e) => day(e.end) + DAY >= now && day(e.start) - AHEAD * DAY <= now);
}

// Tournois candidats sur les deux sites officiels.
function candidates(entry, { ftl = [], engarde = [] }) {
  const found = [];
  for (const t of ftl)
    if (entry.city && sameCity(entry.city, t.location) && sameDates(entry, t.start))
      found.push({
        provider: 'ftl',
        name: t.name,
        country: String(t.location || '')
          .split(',')
          .pop()
          .trim()
          .toUpperCase(),
        sourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${String(t.id).toUpperCase()}`,
      });
  for (const t of engarde)
    if (entry.city && sameCity(entry.city, t.city) && sameDates(entry, t.date_from, t.date_to))
      found.push({
        provider: 'engarde',
        name: t.title,
        country: String(t.ioc_country_code || t.ioc_competition || '').toUpperCase(),
        sourceUrl: `https://engarde-service.com/tournament/${t.org}/${t.ev}`,
      });
  return found;
}

async function ftlList(client, now) {
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const data = await client.get(
    `/tournaments/search/data/advanced?from=${iso(now - 3 * DAY)}&to=${iso(now + (AHEAD + 10) * DAY)}`,
  );
  return Array.isArray(data) ? data : [];
}
async function engardeList(client) {
  const text = await client.get('/prog/getTournoisForDisplay.php');
  try {
    const data = JSON.parse(text);
    return Array.isArray(data?.events) ? data.events : [];
  } catch {
    return [];
  }
}

// Fuseau du lieu d'après le pays de la source officielle (code CIO), sinon géocodage de la ville.
const ZONES = {
  FRA: 'Europe/Paris',
  BEL: 'Europe/Brussels',
  SUI: 'Europe/Zurich',
  LUX: 'Europe/Luxembourg',
  ITA: 'Europe/Rome',
  ESP: 'Europe/Madrid',
  GER: 'Europe/Berlin',
  HUN: 'Europe/Budapest',
  POL: 'Europe/Warsaw',
  SWE: 'Europe/Stockholm',
  SVK: 'Europe/Bratislava',
  TUR: 'Europe/Istanbul',
  GEO: 'Asia/Tbilisi',
  TUN: 'Africa/Tunis',
  CHN: 'Asia/Shanghai',
  SGP: 'Asia/Singapore',
  HKG: 'Asia/Hong_Kong',
  PER: 'America/Lima',
  BRA: 'America/Sao_Paulo',
  UZB: 'Asia/Tashkent',
  GBR: 'Europe/London',
  USA: 'America/New_York',
};
async function venueOf(entry, country, deps) {
  if (ZONES[country]) return { timezone: ZONES[country], city: entry.city };
  try {
    const found = await (deps.searchCities || require('./venue').searchCities)(entry.city);
    if (found?.[0]?.timezone) return { timezone: found[0].timezone, city: found[0].name };
  } catch {
    /* sans géocodage : fuseau de Paris (calendrier FFE) */
  }
  return { timezone: 'Europe/Paris', city: entry.city };
}

// Liens déjà établis entre le calendrier et les tournois de l'application.
async function links(db) {
  const rows = await db.auditLog.findMany({
    where: { action: LINKED, targetType: 'CalendarEvent' },
    orderBy: { id: 'asc' },
    select: { after: true, createdAt: true },
  });
  const map = new Map();
  for (const r of rows) if (r.after?.calendarId) map.set(r.after.calendarId, { ...r.after, at: r.createdAt });
  return map;
}

// Un passage : pour chaque entrée à surveiller, cherche le tournoi officiel et ajoute les épreuves.
async function watch(db, deps = {}) {
  const now = deps.now ?? Date.now();
  const entries = due(now);
  if (!entries.length) return { checked: 0, added: [] };
  const admin = await db.user.findFirst({ where: { isAdmin: true }, orderBy: { id: 'asc' }, select: { id: true } });
  if (!admin) return { checked: 0, added: [] };
  const known = await links(db);
  const ftl = deps.ftl || require('./ftlClient').createClient();
  const engarde = deps.engarde || require('./engardeTournament').createEngardeClient();
  const lists = { ftl: [], engarde: [] };
  try {
    lists.engarde = await engardeList(engarde);
  } catch (e) {
    reportError(e, 'calendrier : liste engarde-service');
  }
  try {
    await ftl.login();
    lists.ftl = await ftlList(ftl, now);
  } catch (e) {
    reportError(e, 'calendrier : liste FencingTimeLive');
  }
  const ftlTournament = deps.ftlTournament || require('./ftlTournament');
  const added = [],
    problems = [];
  for (const entry of entries) {
    for (const source of candidates(entry, lists)) {
      try {
        // Source déjà reliée : un nouveau contrôle par jour suffit (épreuves ajoutées plus tard).
        if (
          known.get(entry.id)?.sourceUrl === source.sourceUrl &&
          now - (rechecked.get(source.sourceUrl) || 0) < 20 * 3600000
        )
          continue;
        rechecked.set(source.sourceUrl, now);
        const venue = await venueOf(entry, source.country, deps);
        const preview = await ftlTournament.preview(
          db,
          { sourceUrl: source.sourceUrl, timezone: venue.timezone, city: venue.city },
          admin.id,
          deps.client,
        );
        const matching = preview.events.filter((e) => wanted(entry, e.event));
        if (!matching.length) continue;
        const missing = matching.filter((e) => !e.existingCompetitionId);
        let tournamentId = null,
          names = [];
        if (missing.length) {
          const saveEvents = (ids) =>
            ftlTournament.save(db, { previewId: preview.previewId, eventIds: ids }, admin.id, deps.client);
          let results = [];
          try {
            results = [await saveEvents(missing.map((e) => e.eventId))];
          } catch (e) {
            // Une épreuve illisible (liste d'engagés incomplète…) ne bloque pas les autres : une par une.
            if (missing.length < 2) throw e;
            for (const ev of missing)
              try {
                results.push(await saveEvents([ev.eventId]));
              } catch (one) {
                problems.push(`${entry.city} (${entry.start}) · ${ev.event} : ${one.message}`);
              }
            if (!results.length) throw e;
          }
          tournamentId = results[0].tournamentId;
          names = results.flatMap((r) => r.events.filter((e) => e.created).map((e) => e.name));
          if (names.length) added.push({ calendarId: entry.id, tournamentId, name: results[0].name, events: names });
        } else {
          const c = await db.competition.findUnique({
            where: { id: matching[0].existingCompetitionId },
            select: { tournamentId: true },
          });
          tournamentId = c?.tournamentId || null;
        }
        if (tournamentId && known.get(entry.id)?.tournamentId !== tournamentId) {
          await db.auditLog.create({
            data: {
              actorId: admin.id,
              action: LINKED,
              targetType: 'CalendarEvent',
              targetId: tournamentId,
              after: { calendarId: entry.id, tournamentId, sourceUrl: source.sourceUrl, provider: source.provider },
            },
          });
          known.set(entry.id, { calendarId: entry.id, tournamentId, sourceUrl: source.sourceUrl });
        }
      } catch (e) {
        problems.push(`${entry.city} (${entry.start}) : ${e.message}`);
        if (!e.status) reportError(e, 'calendrier : ajout automatique');
      }
    }
  }
  if (added.length) {
    await db.auditLog.create({
      data: { actorId: admin.id, action: ACTOR_ACTION, targetType: 'Calendar', targetId: 0, after: { added } },
    });
    const { notifyAdmins } = require('./syncHealth');
    await notifyAdmins(
      db,
      {
        title: 'Nouvelles épreuves ajoutées automatiquement',
        body: added.map((a) => `${a.name} : ${a.events.join(', ')}`).join(' · '),
        tag: 'calendar-watch',
        url: '/admin',
      },
      deps,
    ).catch((e) => reportError(e, 'calendrier : alerte'));
  }
  await db.auditLog.create({
    data: {
      actorId: admin.id,
      action: WATCHED,
      targetType: 'Calendar',
      targetId: 0,
      after: {
        checked: entries.length,
        sources: { ftl: lists.ftl.length, engarde: lists.engarde.length },
        added: added.length,
        problems,
      },
    },
  });
  return { checked: entries.length, added, problems };
}

// Calendrier public : épreuves à venir, avec le tournoi de l'application quand il existe déjà.
async function upcoming(db, now = Date.now()) {
  const known = await links(db);
  const ids = [...new Set([...known.values()].map((l) => l.tournamentId))];
  const live = ids.length
    ? new Set((await db.tournament.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id))
    : new Set();
  return events()
    .filter((e) => day(e.end) + DAY > now)
    .map((e) => {
      const link = known.get(e.id);
      return { ...e, tournamentId: link && live.has(link.tournamentId) ? link.tournamentId : null };
    });
}

function startWorker(db, every = 3 * 3600000) {
  if (process.env.CALENDAR_WATCH === 'false') return () => null;
  let current = null;
  const run = () =>
    (current = watch(db)
      .then((done) => {
        beat('calendar');
        if (done.added.length) console.log(`Calendrier : ${JSON.stringify(done.added)}`);
      })
      .catch((error) => reportError(error, 'surveillance du calendrier')));
  const first = setTimeout(run, 10 * 60000);
  const timer = setInterval(run, every);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    return current;
  };
}

module.exports = { events, classify, wanted, sameCity, sameDates, candidates, due, watch, upcoming, startWorker };
