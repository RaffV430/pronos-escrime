const {withCountries}=require('../services/matchCountries');
const express = require('express');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { syncMatchesFromSheet } = require('../services/sheetSync'); 

const router = express.Router();
const prisma = require('../lib/prisma');
const { matchClosed, closesAt } = require('../lib/matchLock');
const {timedMatches,timedMatch,reopenRound} = require('../services/roundTiming');

router.get('/freshness/:competitionId',authMiddleware,async(req,res)=>{
 const competitionId=Number(req.params.competitionId);if(!Number.isSafeInteger(competitionId)||competitionId<1)return res.status(400).json({error:'Épreuve invalide.'});
 try{const state=await prisma.ftlSyncState.findUnique({where:{competitionId}});res.json({...require('../services/playerExperience').freshness(state),automatic:require('../services/ftlScheduler').enabled()});}catch{res.status(503).json({error:'État de synchronisation indisponible.'});}
});
router.get('/sync-ftl/:competitionId',authMiddleware,adminMiddleware,async(req,res)=>{
 const id=Number(req.params.competitionId);
 if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Épreuve invalide.'});
 try{res.json(await require('../services/ftlSync').syncStatus(prisma,id));}catch{res.status(500).json({error:'État du contrôle indisponible.'});}
});
router.post('/sync-ftl',authMiddleware,adminMiddleware,async(req,res)=>{
 const id=Number(req.body.competitionId);
 if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Épreuve invalide.'});
 try{res.json(await require('../services/ftlSync').syncCompetition(prisma,id,req.user.userId));}
 catch(e){if(e.retryAfter)res.set('Retry-After',String(e.retryAfter));res.status(e.status||500).json({error:e.status?e.message:'Contrôle indisponible.',retryAfter:e.retryAfter});}
});

// 1. Liste de tous les matchs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { competitionId } = req.query;
    const filter = {...(competitionId ? { competitionId: parseInt(competitionId, 10) } : {}),OR:[{resultType:null},{resultType:{not:'CANCELLED'}}]};

    const matches = await prisma.match.findMany({
      where: filter,
      include: { competition: { select: { name: true, podiumFormat: true, podiumRoster: true } }, predictions: { where: { userId: req.user.userId } } },
      orderBy: { id: 'asc' },
    });
    res.json((await timedMatches(prisma,matches)).map(match => ({ ...withCountries(match), maxScore: match.competition?.podiumFormat === 'TEAM' ? 45 : 15, isClosed: matchClosed(match), closesAt: closesAt(match), winnerName: match.winner === 1 ? match.player1 : match.winner === 2 ? match.player2 : null })));
  } catch (error) {
    console.error('Erreur matches:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.' });
  }
});

// 2. Synchronisation Google Sheet
router.post('/sync-sheet', authMiddleware, adminMiddleware, async (req, res) => {
  const { competitionId } = req.body;
  if (!competitionId) {
    return res.status(400).json({ error: 'Veuillez sélectionner une compétition pour synchroniser.' });
  }

  try {
    const result = await syncMatchesFromSheet(competitionId);
    res.json({ message: 'Synchronisation terminée !', details: result });
  } catch (error) {
    console.error('Erreur synchro Sheet:', error);
    res.status(500).json({ error: error.message || 'Échec de la synchronisation' });
  }
});

// 3. Classement général TOTAL (Avec filtres optionnels : competitionId ou tournamentId)
router.get('/leaderboard',authMiddleware,async(req,res)=>{
 try { const {id}=require('../services/poolRules'); const filter={}; for(const k of ['competitionId','tournamentId'])if(req.query[k])filter[k]=id(req.query[k]); res.json(await require('../services/standings').standings(prisma,filter)); }
 catch(e){res.status(e.status||500).json({error:e.status?e.message:'Classement indisponible.'});}
});

// 4. POST : Ajouter ou modifier un pronostic
router.post('/:id/predict', authMiddleware, async (req, res) => {
  const matchId = Number(req.params.id); 
  const userId = req.user.userId;
  const predictedScore1 = req.body.predictedScore1;
  const predictedScore2 = req.body.predictedScore2;

  if (!Number.isInteger(matchId) || !Number.isInteger(predictedScore1) || !Number.isInteger(predictedScore2)
      || predictedScore1 < 0 || predictedScore2 < 0 || predictedScore1 > 999 || predictedScore2 > 999) {
    return res.status(400).json({ error: 'Les deux scores doivent être des entiers valides.' });
  }

  try {
    const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) return { status: 404, body: { error: 'Match introuvable.' } };
    if (matchClosed(await timedMatch(tx,match))) return { status: 409, body: { error: 'Les pronostics sont clos ou la vérification du match est en attente.' } };

    const competition = await tx.competition.findUnique({ where: { id: match.competitionId } });
    const maxScore = competition?.podiumFormat === 'TEAM' ? 45 : 15;
    if (predictedScore1 > maxScore || predictedScore2 > maxScore || predictedScore1 === predictedScore2) return { status: 400, body: { error: `Scores distincts entre 0 et ${maxScore} requis.` } };
    const prediction = await tx.prediction.upsert({
      where: { userId_matchId: { userId: userId, matchId: matchId } },
      update: { predictedScore1, predictedScore2, pointsEarned: 0 },
      create: { userId: userId, matchId: matchId, predictedScore1, predictedScore2 },
    });
    return { status: 200, body: prediction };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la sauvegarde du pronostic' });
  }
});

// 5. DELETE : Supprimer un pronostic
router.delete('/:id/predict', authMiddleware, async (req, res) => {
  const matchId = Number(req.params.id);
  const userId = req.user.userId;

  try {
    const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) return { status: 404, body: { error: 'Match introuvable.' } };
    if (matchClosed(await timedMatch(tx,match))) return { status: 409, body: { error: 'Les pronostics sont clos ou la vérification du match est en attente.' } };

    await tx.prediction.deleteMany({
      where: { userId: userId, matchId: matchId },
    });
    return { status: 200, body: { success: true, message: 'Pronostic supprimé avec succès' } };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression du pronostic' });
  }
});

// Existing individual endpoint can still close a match, but cannot reopen indefinitely.
router.put('/:id/lock', authMiddleware, adminMiddleware, async (req,res)=>{
 const id=Number(req.params.id);
 if(!Number.isSafeInteger(id)||id<=0||req.body.isLocked!==true)return res.status(400).json({error:'Pour rouvrir, utilisez la réouverture du tour pendant 10 minutes.'});
 try {
  const result=await prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${id} FOR UPDATE`;
   const match=await tx.match.findUnique({where:{id}});
   if(!match)return {status:404,error:'Match introuvable.'};
   const updated=await tx.match.update({where:{id},data:{isLocked:true,manualUnlock:false}});
   await tx.auditLog.create({data:{actorId:req.user.userId,action:'Verrouillage',targetType:'Match',targetId:id,before:{isLocked:match.isLocked},after:{isLocked:true}}});
   return {match:updated};
  });res.status(result.status||200).json(result);
 }catch{res.status(500).json({error:'Verrouillage impossible.'});}
});
// An explicit import step: counts must come from the full official bracket, not imported pairs.
router.put('/rounds/:competitionId/manifest',authMiddleware,adminMiddleware,async(req,res)=>{
 const competitionId=Number(req.params.competitionId),{sourceUrl}=req.body;
 let rounds;
 try{
  if(!Number.isSafeInteger(competitionId)||competitionId<=0||typeof sourceUrl!=='string'||!/^https:\/\/www\.fencingtimelive\.com\/tableaus\/scores\/[a-f0-9]{32}\/[a-f0-9]{32}$/i.test(sourceUrl))throw new Error('Source officielle et épreuve requises.');
  rounds=require('../services/roundManifest').validateManifest(req.body.rounds);
 }catch(e){return res.status(400).json({error:e.message});}
 try{
  const result=await prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${competitionId} FOR UPDATE`;
   const competition=await tx.competition.findUnique({where:{id:competitionId}});
   if(!competition)return {status:404,error:'Épreuve introuvable.'};
   const existing=await tx.match.findMany({where:{competitionId}});
   if(!existing.some(m=>m.sourceUrl===sourceUrl))return {status:409,error:'Source non rattachée aux matchs de cette épreuve.'};
   if(existing.some(m=>!rounds.some(r=>r.round===m.round))||rounds.some(r=>existing.filter(m=>m.round===r.round).length>r.expectedMatchCount))return {status:409,error:'Composition importée incompatible avec le tableau officiel.'};
   const before=await tx.matchRound.findMany({where:{competitionId}});
   if(before.some(r=>!rounds.some(n=>n.round===r.round)))return {status:409,error:'Un tour déjà configuré ne peut pas être supprimé.'};
   for(const r of rounds)await tx.matchRound.upsert({where:{competitionId_round:{competitionId,round:r.round}},create:{competitionId,...r,sourceUrl,verifiedAt:new Date()},update:{...r,sourceUrl,verifiedAt:new Date()}});
   await tx.auditLog.create({data:{actorId:req.user.userId,action:'Vérification du tableau et des délais par tour',targetType:'Competition',targetId:competitionId,after:{sourceUrl,rounds}}});
   return {rounds};
  });res.status(result.status||200).json(result);
 }catch{res.status(500).json({error:'Configuration du tableau impossible.'});}
});
router.put('/rounds/:competitionId/:round/unlock',authMiddleware,adminMiddleware,async(req,res)=>{
 const competitionId=Number(req.params.competitionId),round=req.params.round;
 if(!Number.isSafeInteger(competitionId)||competitionId<=0||!round||round.length>80)return res.status(400).json({error:'Tour invalide.'});
 try{const result=await prisma.$transaction(tx=>reopenRound(tx,competitionId,round,req.user.userId));res.status(result.status||200).json(result);}
 catch{res.status(500).json({error:'Réouverture du tour impossible.'});}
});

router.put('/:id/medical-withdrawal', authMiddleware, adminMiddleware, async (req, res) => {
  const id = Number(req.params.id), winner = req.body.winner;
  if (!Number.isInteger(id) || id <= 0 || ![1, 2].includes(winner)) return res.status(400).json({ error: 'Choisissez le tireur qualifié (1 ou 2).' });
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${id} FOR UPDATE`;
      const current = await tx.match.findUnique({ where: { id } });
      if (!current) return { status: 404, error: 'Match introuvable.' };
      if(current.resultType==='CANCELLED')return {status:409,error:'Cette affiche a été annulée.'};
      const match = await tx.match.update({ where: { id }, data: { winner, resultType: 'MEDICAL_WITHDRAWAL', score1: null, score2: null, isFinished: true, isLocked: true, manualUnlock: false } });
      const predictions = await tx.prediction.findMany({ where: { matchId: id } });
      const { calculateMatchPoints } = require('../services/matchPoints');
      for (const p of predictions) await tx.prediction.update({ where: { id: p.id }, data: { pointsEarned: calculateMatchPoints(p.predictedScore1, p.predictedScore2, null, null, winner, 'MEDICAL_WITHDRAWAL') } });
      await tx.auditLog.create({data:{actorId:req.user.userId,action:'Retrait médical',targetType:'Match',targetId:id,after:{winner}}});
      return { match };
    });
    res.status(result.status || 200).json(result);
  } catch { res.status(500).json({ error: 'Impossible de valider le retrait médical.' }); }
});

// Explicit administrative correction of a published official score.
router.put('/:id/result', authMiddleware, adminMiddleware, async (req,res)=>{
 const id=Number(req.params.id),{score1,score2,reason,sourceUrl}=req.body;
 if(!Number.isSafeInteger(id)||id<=0||![score1,score2].every(Number.isInteger)||score1<0||score2<0||score1===score2||typeof reason!=='string'||reason.trim().length<3||reason.length>250)return res.status(400).json({error:'Deux scores distincts et un motif de correction sont requis.'});
 try{
  const outcome=await prisma.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "Match" WHERE id=${id} FOR UPDATE`;
   const current=await tx.match.findUnique({where:{id}});if(!current)return {status:404,error:'Match introuvable.'};
   if(current.resultType==='CANCELLED')return {status:409,error:'Cette affiche a été annulée.'};
   if(!current.sourceUrl||current.sourceUrl!==sourceUrl)return {status:409,error:'Vérifiez la source officielle enregistrée de ce match.'};
   const c=await tx.competition.findUnique({where:{id:current.competitionId}}),max=c?.podiumFormat==='TEAM'?45:15;
   if(score1>max||score2>max)return {status:400,error:`Scores limités à ${max} touches.`};
   const winner=score1>score2?1:2;
   const match=await tx.match.update({where:{id},data:{score1,score2,winner,resultType:'NORMAL',isFinished:true,isLocked:true,manualUnlock:false}});
   const predictions=await tx.prediction.findMany({where:{matchId:id}});
   for(const p of predictions)await tx.prediction.update({where:{id:p.id},data:{pointsEarned:require('../services/matchPoints').calculateMatchPoints(p.predictedScore1,p.predictedScore2,score1,score2)}});
   await tx.auditLog.create({data:{actorId:req.user.userId,action:'Correction du résultat officiel',targetType:'Match',targetId:id,before:{score1:current.score1,score2:current.score2,winner:current.winner,resultType:current.resultType},after:{score1,score2,winner,reason:reason.trim(),sourceUrl}}});
   return {match};
  });res.status(outcome.status||200).json(outcome);
 }catch{res.status(500).json({error:'Correction impossible.'});}
});
module.exports = router;
