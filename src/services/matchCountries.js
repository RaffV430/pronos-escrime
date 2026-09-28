const isoAliases = {
  ALG: 'DZA',
  ANG: 'AGO',
  ANT: 'ATG',
  BAH: 'BHS',
  BAN: 'BGD',
  BAR: 'BRB',
  BER: 'BMU',
  BHU: 'BTN',
  BOT: 'BWA',
  BRN: 'BHR',
  BRU: 'BRN',
  BUL: 'BGR',
  BUR: 'BFA',
  CAM: 'KHM',
  CAY: 'CYM',
  CGO: 'COG',
  CHA: 'TCD',
  CHI: 'CHL',
  CRC: 'CRI',
  CRO: 'HRV',
  DEN: 'DNK',
  ESA: 'SLV',
  FIJ: 'FJI',
  GAM: 'GMB',
  GBS: 'GNB',
  GEQ: 'GNQ',
  GER: 'DEU',
  GRE: 'GRC',
  GRN: 'GRD',
  GUA: 'GTM',
  GUI: 'GIN',
  HAI: 'HTI',
  HON: 'HND',
  INA: 'IDN',
  IRI: 'IRN',
  ISV: 'VIR',
  IVB: 'VGB',
  KOS: 'XKX',
  KSA: 'SAU',
  KUW: 'KWT',
  LAT: 'LVA',
  LBA: 'LBY',
  LES: 'LSO',
  LIB: 'LBN',
  MAD: 'MDG',
  MAS: 'MYS',
  MAW: 'MWI',
  MGL: 'MNG',
  MON: 'MCO',
  MRI: 'MUS',
  MTN: 'MRT',
  MYA: 'MMR',
  NCA: 'NIC',
  NED: 'NLD',
  NEP: 'NPL',
  NGR: 'NGA',
  NIG: 'NER',
  OMA: 'OMN',
  PAR: 'PRY',
  PHI: 'PHL',
  PLE: 'PSE',
  POR: 'PRT',
  PUR: 'PRI',
  RSA: 'ZAF',
  SLO: 'SVN',
  SOL: 'SLB',
  SRI: 'LKA',
  SUD: 'SDN',
  SUI: 'CHE',
  TAN: 'TZA',
  TGA: 'TON',
  TOG: 'TGO',
  TPE: 'TWN',
  UAE: 'ARE',
  URU: 'URY',
  VAN: 'VUT',
  VIE: 'VNM',
  VIN: 'VCT',
  ZAM: 'ZMB',
  ZIM: 'ZWE',
};
const normalize = (s) =>
  String(s || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
function countryFor(roster, name) {
  const found = (Array.isArray(roster) ? roster : []).filter((r) => normalize(r.name) === normalize(name));
  if (found.length !== 1) return null;
  const code = normalize(found[0].country);
  return /^[A-Z]{3}$/.test(code) && !['AIN', 'FIE', 'EFC', 'REF', 'IOA', 'ROC'].includes(code)
    ? isoAliases[code] || code
    : null;
}
function withCountries(match) {
  const { podiumRoster, ...competition } = match.competition || {};
  return {
    ...match,
    competition,
    player1Country: countryFor(podiumRoster, match.player1),
    player2Country: countryFor(podiumRoster, match.player2),
  };
}
// Code olympique (CIO) tel que publié dans la liste des engagés : FRA, GER, SUI…
function olympicCodeFor(roster, name) {
  const found = (Array.isArray(roster) ? roster : []).filter((r) => normalize(r.name) === normalize(name));
  if (found.length !== 1) return null;
  const code = normalize(found[0].country);
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
// Rang d'entrée dans l'épreuve (liste des engagés FencingTimeLive), si le nom est unique.
function entryRankFor(roster, name) {
  const found = (Array.isArray(roster) ? roster : []).filter((r) => normalize(r.name) === normalize(name));
  const rank = found.length === 1 ? found[0].entryRanking : null;
  return Number.isSafeInteger(rank) && rank > 0 ? rank : null;
}
module.exports = { countryFor, olympicCodeFor, withCountries, entryRankFor };
