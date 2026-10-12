const { key } = require('./fencerAffiliations');
const records = require('../../prisma/data/ffe-birth-years-2026-10-09.json');
const years = new Map();
for (const row of records) {
  const name = key(row.name);
  const previous = years.get(name);
  years.set(name, previous === undefined || previous === row.birthYear ? row.birthYear : null);
}
const categories = ['M5', 'M7', 'M9', 'M11', 'M13', 'M15', 'M17', 'M20', 'SENIOR', 'V1', 'V2', 'V3', 'V4'];
// Saison fédérale : septembre à août ; âge atteint pendant l'année de fin de saison.
function ageCategory(birthYear, now = new Date()) {
  if (!Number.isInteger(birthYear)) return null;
  const parts = new Intl.DateTimeFormat('fr', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year').value);
  const month = Number(parts.find((p) => p.type === 'month').value);
  const age = year + (month >= 9 ? 1 : 0) - birthYear;
  if (age < 0 || age > 125) return null;
  return categories[[5, 7, 9, 11, 13, 15, 17, 20, 39, 49, 59, 69, 125].findIndex((limit) => age <= limit)];
}
function verifiedCategory(profile, now) {
  return profile?.federationVerified
    ? ageCategory(profile.birthYear ?? (profile.country === 'FRA' ? years.get(key(profile.name)) : null), now)
    : null;
}
module.exports = { categories, ageCategory, verifiedCategory };
