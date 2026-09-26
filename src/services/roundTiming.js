const {roundContext, GRACE_MS} = require('../lib/matchLock');
async function timedMatches(tx, matches) {
  const competitionIds = [...new Set(matches.map(m => m.competitionId))];
  const rounds = await tx.matchRound.findMany({where:{competitionId:{in:competitionIds}}});
  return roundContext(matches, rounds);
}
async function timedMatch(tx, match) {
  const matches = await tx.match.findMany({where:{competitionId:match.competitionId}});
  return (await timedMatches(tx, matches)).find(m => m.id === match.id);
}
async function reopenRound(tx, competitionId, round, actorId) {
  await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Match" WHERE "competitionId"=${competitionId} AND round=${round} ORDER BY id FOR UPDATE`;
  const config = await tx.matchRound.findUnique({where:{competitionId_round:{competitionId,round}}});
  if (!config) return {status:409,error:'Le tour doit être vérifié et configuré lors de l’import officiel.'};
  const pending = await tx.match.count({where:{competitionId,round,isFinished:false}});
  if (!pending) return {status:409,error:'Aucun match non terminé à rouvrir dans ce tour.'};
  const until = new Date(Date.now()+GRACE_MS);
  await tx.matchRound.update({where:{competitionId_round:{competitionId,round}},data:{manualUnlockUntil:until}});
  await tx.auditLog.create({data:{actorId,action:'Réouverture du tour pour 10 minutes',targetType:'Competition',targetId:competitionId,before:{round,manualUnlockUntil:config.manualUnlockUntil},after:{round,manualUnlockUntil:until.toISOString(),matches:pending}}});
  return {round,manualUnlockUntil:until, matches:pending};
}
module.exports={timedMatches,timedMatch,reopenRound};
