const fields = format => format === 'TEAM' ? ['gold', 'silver', 'bronze1'] : ['gold', 'silver', 'bronze1', 'bronze2'];
const normalize = value => String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function roster(competition) {
  if (!['INDIVIDUAL','TEAM'].includes(competition.podiumFormat)) fail('Format de podium non configuré.',409);
  const entries = competition.podiumRoster;
  if (!Array.isArray(entries) || !entries.length || entries.some(e => !e.id || !e.name) || new Set(entries.map(e=>e.id)).size !== entries.length) fail('Liste officielle des engagés indisponible.',409);
  return entries;
}
function validateSelection(competition, selected, allowInactive = false) {
  const entries = roster(competition), slots = fields(competition.podiumFormat);
  if (!selected || typeof selected !== 'object' || slots.some(k=>typeof selected[k] !== 'string') || new Set(slots.map(k=>selected[k])).size !== slots.length) fail('Sélectionnez des engagés différents pour chaque médaille.');
  if (competition.podiumFormat === 'TEAM' && selected.bronze2) fail('Un seul bronze est attribué par équipes.');
  const names = {}, ids = {};
  for (const k of slots) {
    const entry=entries.find(e=>e.id===selected[k]);
    if (!entry || (!allowInactive && entry.active===false)) fail('Un engagé sélectionné ne participe pas à cette épreuve.');
    names[k]=entry.name; ids[k]=entry.id;
  }
  return {names:{...names,bronze2:names.bronze2 || ''},ids};
}
function verifiedPodium(competition) {
  const event=/^https:\/\/www\.fencingtimelive\.com\/events\/competitors\/([A-F0-9]{32})$/i.exec(competition.rosterSourceUrl || '')?.[1];
  const result=/^https:\/\/www\.fencingtimelive\.com\/events\/results\/([A-F0-9]{32})$/i.exec(competition.resultsSourceUrl || '')?.[1];
  const official=competition.officialPodium;
  if (!event || event.toUpperCase()!==result?.toUpperCase() || !competition.resultsVerifiedAt || !official?.finalConfirmed || (competition.podiumFormat==='TEAM' && !official?.bronzeMatchConfirmed)) fail('En attente des résultats officiels définitifs après la finale et, par équipes, la petite finale.',409);
  return validateSelection(competition,official,true).ids;
}
function predictionIds(competition,prediction) {
  if (prediction.selectionIds) return validateSelection(competition,prediction.selectionIds,true).ids;
  // Legacy predictions are reconciled only against a unique complete name.
  const entries=roster(competition), selected={};
  for(const k of fields(competition.podiumFormat)) {
    const found=entries.filter(e=>normalize(e.name)===normalize(prediction[k]));
    if(found.length!==1) fail(`Ancien pronostic ${prediction.id} ambigu : vérification nécessaire.`,409);
    selected[k]=found[0].id;
  }
  return validateSelection(competition,selected,true).ids;
}
function podiumPoints(format,predicted,official) {
  const slots=fields(format), all=slots.map(k=>official[k]);
  const bronzes=format==='TEAM'?[official.bronze1]:[official.bronze1,official.bronze2];
  return slots.reduce((sum,k)=>sum+((k.startsWith('bronze')?bronzes.includes(predicted[k]):predicted[k]===official[k])?15:all.includes(predicted[k])?5:0),0);
}
async function resolvePodium(tx,competitionId) {
  await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
  const competition=await tx.competition.findUnique({where:{id:competitionId}});
  if(!competition) fail('Compétition introuvable.',404);
  const official=verifiedPodium(competition);
  const predictions=await tx.podiumPrediction.findMany({where:{competitionId}});
  for(const prediction of predictions) {
    const selected=predictionIds(competition,prediction);
    await tx.podiumPrediction.update({where:{id:prediction.id},data:{pointsEarned:podiumPoints(competition.podiumFormat,selected,official)}});
  }
  await tx.competition.update({where:{id:competitionId},data:{isPodiumLocked:true,podiumManualUnlock:false,podiumResolvedAt:new Date()}});
  return predictions.length;
}
module.exports={fields,roster,validateSelection,verifiedPodium,predictionIds,podiumPoints,resolvePodium};
