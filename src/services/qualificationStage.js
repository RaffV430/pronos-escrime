// Journée qualificative publiée à part sur engarde (ex. Nationale 2 de Pont-à-Mousson : qualification le
// samedi, épreuve nationale le dimanche). Elle reste une compétition distincte, comme sur la source, mais
// sans podium : son tableau s'arrête aux qualifiés du lendemain. Déclarée dans le calendrier
// (qualificationStages : lien engarde de la journée), jamais devinée.
const DATA = require('../data/calendar.json');
const { parseLink } = require('./engardeParser');

const KEYS = new Set(
  DATA.events
    .flatMap((e) => e.qualificationStages || [])
    .map(parseLink)
    .filter((link) => link?.kind === 'competition')
    .map((link) => `ENGARDE:${link.org}/${link.event}/${link.compe}`),
);
const isQualification = (competition) => KEYS.has(competition?.ftlEventId);
const SUFFIX = ' — qualification';
const stageName = (name, ftlEventId) => (isQualification({ ftlEventId }) ? name + SUFFIX : name);
const REASON = 'Épreuve qualificative : pas de podium à pronostiquer. Le podium se joue sur l’épreuve du lendemain.';

module.exports = { isQualification, stageName, REASON };
