// Lieu de compétition : l'administrateur choisit une ville, le fuseau horaire IANA en est déduit.
// Recherche via le géocodage public Open-Meteo (sans clé), résultats limités et validés.
const axios = require('axios');
const { failure } = require('./ftlClient');

const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';

function validTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

// Décalage UTC du fuseau à une date donnée, en minutes (ex. 120 pour Europe/Budapest l'été).
function utcOffset(timezone, at = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((local - Math.floor(at / 60000) * 60000) / 60000);
}

function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+',
    abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : ''}`;
}

// Libellé lisible du lieu, conservé dans la configuration pour l'affichage.
function cleanCity(value) {
  const city = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (city.length > 120) throw failure('Nom de ville trop long.', 400);
  return city || null;
}

function toCandidates(results, at = Date.now()) {
  const seen = new Set();
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && typeof r.name === 'string' && validTimezone(r.timezone))
    .map((r) => {
      const offset = utcOffset(r.timezone, at);
      return {
        name: r.name,
        region: typeof r.admin1 === 'string' && r.admin1 !== r.name ? r.admin1 : null,
        country: typeof r.country === 'string' ? r.country : null,
        countryCode: typeof r.country_code === 'string' ? r.country_code : null,
        timezone: r.timezone,
        offset: offsetLabel(offset),
        label: [r.name, typeof r.country === 'string' ? r.country : null].filter(Boolean).join(', '),
      };
    })
    .filter((c) => {
      const key = [c.name, c.region, c.country, c.timezone].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

async function searchCities(query, { http = axios, at = Date.now() } = {}) {
  const q = String(query || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (q.length < 2) return [];
  if (q.length > 80) throw failure('Recherche trop longue.', 400);
  let data;
  try {
    ({ data } = await http.get(GEOCODING, {
      params: { name: q, count: 10, language: 'fr', format: 'json' },
      timeout: 8000,
    }));
  } catch {
    throw failure('Recherche de ville indisponible. Saisissez le fuseau manuellement.', 502);
  }
  return toCandidates(data?.results, at);
}

module.exports = { searchCities, toCandidates, validTimezone, utcOffset, offsetLabel, cleanCity };
