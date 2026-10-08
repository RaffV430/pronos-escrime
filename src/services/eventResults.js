// « Résultats des épreuves » : résultats sportifs des tournois passés (podium officiel, date, lieu),
// indépendamment des pronostics. Fonctions pures ; la route lit la base.
const { seasonOf } = require('./season');

// Pays du lieu : code CIO publié par engarde-service, sinon fuseau horaire choisi à la configuration.
const CIO = {
  FRA: 'FR',
  ITA: 'IT',
  GER: 'DE',
  ESP: 'ES',
  HUN: 'HU',
  POL: 'PL',
  GBR: 'GB',
  BEL: 'BE',
  NED: 'NL',
  LUX: 'LU',
  SUI: 'CH',
  AUT: 'AT',
  CZE: 'CZ',
  SVK: 'SK',
  ROU: 'RO',
  BUL: 'BG',
  GRE: 'GR',
  TUR: 'TR',
  UKR: 'UA',
  POR: 'PT',
  IRL: 'IE',
  DEN: 'DK',
  SWE: 'SE',
  NOR: 'NO',
  FIN: 'FI',
  EST: 'EE',
  LAT: 'LV',
  LTU: 'LT',
  CRO: 'HR',
  SLO: 'SI',
  SRB: 'RS',
  GEO: 'GE',
  ISR: 'IL',
  EGY: 'EG',
  ALG: 'DZ',
  TUN: 'TN',
  MAR: 'MA',
  SEN: 'SN',
  USA: 'US',
  CAN: 'CA',
  MEX: 'MX',
  BRA: 'BR',
  ARG: 'AR',
  CHI: 'CL',
  COL: 'CO',
  PER: 'PE',
  VEN: 'VE',
  JPN: 'JP',
  KOR: 'KR',
  CHN: 'CN',
  HKG: 'HK',
  SGP: 'SG',
  KAZ: 'KZ',
  UZB: 'UZ',
  UAE: 'AE',
  QAT: 'QA',
  KSA: 'SA',
  AUS: 'AU',
  NZL: 'NZ',
};
const ZONES = {
  'Europe/Paris': 'FR',
  'Europe/Monaco': 'MC',
  'Europe/Rome': 'IT',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Budapest': 'HU',
  'Europe/Warsaw': 'PL',
  'Europe/London': 'GB',
  'Europe/Brussels': 'BE',
  'Europe/Amsterdam': 'NL',
  'Europe/Luxembourg': 'LU',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Prague': 'CZ',
  'Europe/Bratislava': 'SK',
  'Europe/Bucharest': 'RO',
  'Europe/Sofia': 'BG',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Kyiv': 'UA',
  'Europe/Kiev': 'UA',
  'Europe/Lisbon': 'PT',
  'Europe/Dublin': 'IE',
  'Europe/Copenhagen': 'DK',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Helsinki': 'FI',
  'Europe/Tallinn': 'EE',
  'Europe/Riga': 'LV',
  'Europe/Vilnius': 'LT',
  'Europe/Zagreb': 'HR',
  'Europe/Ljubljana': 'SI',
  'Europe/Belgrade': 'RS',
  'Asia/Tbilisi': 'GE',
  'Asia/Jerusalem': 'IL',
  'Africa/Cairo': 'EG',
  'Africa/Algiers': 'DZ',
  'Africa/Tunis': 'TN',
  'Africa/Casablanca': 'MA',
  'Africa/Dakar': 'SN',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Toronto': 'CA',
  'America/Montreal': 'CA',
  'America/Vancouver': 'CA',
  'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Santiago': 'CL',
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'America/Caracas': 'VE',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Singapore': 'SG',
  'Asia/Almaty': 'KZ',
  'Asia/Tashkent': 'UZ',
  'Asia/Dubai': 'AE',
  'Asia/Qatar': 'QA',
  'Asia/Riyadh': 'SA',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Pacific/Auckland': 'NZ',
  'Indian/Reunion': 'FR',
  'America/Guadeloupe': 'FR',
  'America/Martinique': 'FR',
  'America/Cayenne': 'FR',
  'Pacific/Noumea': 'FR',
  'Pacific/Tahiti': 'FR',
};
function countryOf(config) {
  const cio = String(config?.country || '').toUpperCase();
  return CIO[cio] || ZONES[config?.timezone] || null;
}

// Épreuve terminée : podium officiel publié par la source ou résolu par l'application.
const finished = (c) => Boolean(c.podiumResolvedAt || c.officialPodium?.finalConfirmed);

const PLACES = [
  ['gold', 1],
  ['silver', 2],
  ['bronze1', 3],
  ['bronze2', 3],
];
function podiumOf(c) {
  const roster = Array.isArray(c.podiumRoster) ? c.podiumRoster : [];
  const official = c.officialPodium || {};
  return PLACES.flatMap(([key, place]) => {
    const e = roster.find((x) => x.id === official[key]);
    return e ? [{ place, name: e.name, country: e.country || null }] : [];
  });
}

// Le lieu et les jours de compétition existent avant les résultats. Ne jamais
// utiliser la création en base comme date d’un tournoi à venir.
function tournamentMetadata(tournament, { configs = new Map() } = {}) {
  const details = (tournament.competitions || []).map((c) => configs.get(c.id) || {});
  const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(`${d}T12:00:00Z`));
  const dates = details
    .flatMap((config) => [config.date, ...Object.values(config.phaseDays || {})])
    .filter(validDay)
    .sort();
  return {
    start: dates[0] || null,
    end: dates.at(-1) || null,
    city: details.find((config) => config.city)?.city || null,
    countries: [...new Set(details.map(countryOf).filter(Boolean))],
  };
}

// Tournois triés du plus récent au plus ancien ; seules les épreuves terminées y figurent.
function buildResults(tournaments, { configs = new Map(), firstDates = new Map() } = {}) {
  const out = [];
  for (const t of tournaments) {
    const competitions = (t.competitions || [])
      .filter(finished)
      .map((c) => {
        const config = configs.get(c.id) || null;
        const date =
          (/^\d{4}-\d{2}-\d{2}$/.test(config?.date || '') && config.date) ||
          (firstDates.get(c.id) ? new Date(firstDates.get(c.id)).toISOString().slice(0, 10) : null) ||
          new Date(c.createdAt || t.createdAt).toISOString().slice(0, 10);
        return {
          id: c.id,
          name: c.name,
          format: c.podiumFormat,
          date,
          city: config?.city || null,
          country: countryOf(config),
          podium: podiumOf(c),
          sourceUrl: c.resultsSourceUrl || null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'fr'));
    if (!competitions.length) continue;
    const dates = competitions.map((c) => c.date);
    const start = dates.reduce((a, b) => (a < b ? a : b));
    const end = dates.reduce((a, b) => (a > b ? a : b));
    const countries = [...new Set(competitions.map((c) => c.country).filter(Boolean))];
    out.push({
      id: t.id,
      name: t.name,
      start,
      end,
      season: seasonOf(`${start}T12:00:00Z`),
      city: competitions.find((c) => c.city)?.city || null,
      countries,
      competitions,
    });
  }
  return out.sort((a, b) => b.start.localeCompare(a.start) || b.id - a.id);
}

// « Raffaele Venturi » → « Raffaele V. » ; un pseudonyme d'un seul mot reste tel quel.
const publicName = (name) => {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'Joueur';
  return words.length === 1 ? words[0] : `${words[0]} ${words[1][0].toUpperCase()}.`;
};

// Texte de l'aperçu d'un lien partagé : lieu, dates et vainqueurs connus.
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function shareDates(start, end) {
  if (!start) return '';
  const [y1, m1, d1] = start.split('-').map(Number);
  const [y2, m2, d2] = (end || start).split('-').map(Number);
  if (start === (end || start)) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}
function shareText(t, result) {
  const where = [result?.city, shareDates(result?.start, result?.end)].filter(Boolean).join(' · ');
  const golds = (result?.competitions || [])
    .map((c) => {
      const gold = c.podium.find((p) => p.place === 1);
      return gold
        ? `${c.name.replace(/\s+[—–-]\s+\d{1,2}(er)?\s+\S+\s+\d{4}$/, '')} : ${gold.name}${gold.country ? ` (${gold.country})` : ''}`
        : null;
    })
    .filter(Boolean);
  const body = golds.length
    ? `Vainqueurs — ${golds.slice(0, 3).join(' ; ')}${golds.length > 3 ? '…' : ''}`
    : 'Podiums, tableaux et classement des pronostiqueurs.';
  return [where, body].filter(Boolean).join(' · ');
}

module.exports = { tournamentMetadata, buildResults, countryOf, podiumOf, finished, publicName, shareText, shareDates };
