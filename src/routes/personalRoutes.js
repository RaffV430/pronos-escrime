const router=require('express').Router(),db=require('../lib/prisma');
const {id,fencerClosed,poolPoints}=require('../services/poolRules');
const {matchClosed,closesAt,podiumClosed}=require('../lib/matchLock');
const {calculateMatchPoints}=require('../services/matchPoints');
const {fields,verifiedPodium,predictionIds}=require('../services/podiumRules');
const {timedMatches}=require('../services/roundTiming');
const {standings}=require('../services/standings');
router.use(require('../middleware/auth'));
router.get('/predictions',async(req,res)=>{
 try{
  const competitionId=id(req.query.competitionId),userId=req.user.userId;
  const competition=await db.competition.findUnique({where:{id:competitionId}});if(!competition)return res.status(404).json({error:'Épreuve introuvable.'});
  const [matches,pools,podium]=await Promise.all([
   db.match.findMany({where:{competitionId},include:{predictions:{where:{userId}}},orderBy:{startsAt:'asc'}}),
   db.pool.findMany({where:{competitionId},include:{fencers:{include:{predictions:{where:{userId}}},orderBy:{position:'asc'}}}}),
   db.podiumPrediction.findUnique({where:{userId_competitionId:{userId,competitionId}}})]);
  const rounds=await db.matchRound.findMany({where:{competitionId}});
  const contextual=await timedMatches(db,matches);
  const rows=[];
  for(const m of contextual){const p=m.predictions[0],finished=m.isFinished,closed=matchClosed(m);let details=[];
   if(m.resultType==='CANCELLED'){const originalKey=m.sourceKey?.replace(/^cancelled:\d+:/,'');const replacement=contextual.find(x=>x.resultType!=='CANCELLED'&&x.sourceKey===originalKey&&x.sourceUrl===m.sourceUrl);if(p)rows.push({key:`match-${m.id}`,type:'Match',name:`${m.player1} / ${m.player2}`,round:m.round,status:'Annulé',prediction:`${p.predictedScore1} – ${p.predictedScore2}`,result:'Affiche retirée du tableau officiel',points:0,details:['Tableau officiel modifié : ancien pronostic annulé, sans attribution ni retrait de points.'],replacement:replacement&&!matchClosed(replacement)?{key:`match-${replacement.id}`,name:`${replacement.player1} / ${replacement.player2}`,saved:replacement.predictions.length>0}:null,sourceUrl:m.sourceUrl});continue;}
   if(p&&finished){const total=calculateMatchPoints(p.predictedScore1,p.predictedScore2,m.score1,m.score2,m.winner,m.resultType);const exact=m.resultType!=='MEDICAL_WITHDRAWAL'&&p.predictedScore1===m.score1&&p.predictedScore2===m.score2;details=[`Bon vainqueur : +${total-(exact?3:0)}`,`Score exact : +${exact?3:0}`];}
   rows.push({key:`match-${m.id}`,type:'Match',name:`${m.player1} / ${m.player2}`,round:m.round,status:finished?'Terminé':closed?'Clos':p?'Enregistré':'À compléter',prediction:p?`${p.predictedScore1} – ${p.predictedScore2}`:null,result:finished?(m.resultType==='MEDICAL_WITHDRAWAL'?`Retrait médical · ${m.winner===1?m.player1:m.player2} qualifié(e)`:`${m.score1} – ${m.score2}`):null,points:p&&finished?p.pointsEarned:null,details,startsAt:m.startsAt,closesAt:closesAt(m),manualUnlockUntil:m.manualUnlockUntil,awaitingPreviousRound:m.awaitingPreviousRound,timingUnverified:m.timingUnverified,sourceCheckedAt:m.sourceCheckedAt,sourceUrl:m.sourceUrl});
  }
  for(const pool of pools)for(const f of pool.fencers){const p=f.predictions[0],closed=fencerClosed(pool,f);const pts=p&&pool.isFinal?poolPoints(p,f):null;
   rows.push({key:`pool-${f.id}`,type:'Poule',name:`${pool.name} · ${f.name}`,status:pool.isFinal?'Terminé':closed?'Clos':p?'Enregistré':'À compléter',prediction:p?`${p.wins} V · indice ${p.indicator}`:null,result:pool.isFinal?`${f.wins} V · indice ${f.indicator}`:null,points:pts?p.pointsEarned:null,details:pts?[`Victoires : +${pts.winsPoints}`,`Indice : +${pts.indicatorPoints}`]:[],sourceCheckedAt:pool.sourceCheckedAt,sourceUrl:pool.sourceUrl});
  }
  let official=null;try{official=verifiedPodium(competition);}catch{}
  const slotNames={gold:'Or',silver:'Argent',bronze1:'Bronze',bronze2:'Bronze'};
  let details=[];if(podium&&official){try{const selected=predictionIds(competition,podium),all=Object.values(official);details=fields(competition.podiumFormat).map(k=>{const exact=k.startsWith('bronze')?[official.bronze1,official.bronze2].includes(selected[k]):official[k]===selected[k];return `${slotNames[k]} · ${podium[k]} : +${exact?15:all.includes(selected[k])?5:0}`;});}catch{details=['Ancien choix à vérifier par l’administrateur.'];}}
  rows.push({key:'podium',type:'Podium',name:'Podium de l’épreuve',status:competition.podiumResolvedAt?'Terminé':podiumClosed(competition,matches)?'Clos':podium?'Enregistré':'À compléter',prediction:podium?fields(competition.podiumFormat).map(k=>podium[k]).join(' / '):null,result:official?fields(competition.podiumFormat).map(k=>competition.podiumRoster.find(e=>e.id===official[k])?.name).join(' / '):null,points:podium&&competition.podiumResolvedAt?podium.pointsEarned:null,details,sourceCheckedAt:competition.resultsVerifiedAt,sourceUrl:competition.resultsSourceUrl});
  res.json({competition:{id:competition.id,name:competition.name},rows,rounds:require('../services/playerExperience').roundSummaries(matches,rounds)});
 }catch(e){res.status(e.status||500).json({error:e.status?e.message:'Pronostics indisponibles.'});}
});
router.get('/summary/:tournamentId',async(req,res)=>{
 try{
  const tournamentId=id(req.params.tournamentId),userId=req.user.userId;
  const rows=await standings(db,{tournamentId});
  const predictions=await db.prediction.findMany({where:{userId,match:{competition:{tournamentId},isFinished:true,OR:[{resultType:null},{resultType:{not:'CANCELLED'}}]}},include:{match:true}});
  const exact=predictions.filter(p=>p.match.resultType!=='MEDICAL_WITHDRAWAL'&&p.predictedScore1===p.match.score1&&p.predictedScore2===p.match.score2).length;
  const winners=predictions.filter(p=>calculateMatchPoints(p.predictedScore1,p.predictedScore2,p.match.score1,p.match.score2,p.match.winner,p.match.resultType)>0).length;
  const progress=await require('../services/rankingHistory').rankProgress(db,tournamentId,userId);
  const tournament=await db.tournament.findUnique({where:{id:tournamentId},include:{competitions:{select:{id:true,name:true,podiumResolvedAt:true}}}});
  const allRounds=await db.matchRound.findMany({where:{competitionId:{in:tournament.competitions.map(c=>c.id)}}});
  const allMatches=await db.match.findMany({where:{competition:{tournamentId}},include:{predictions:{where:{userId}}}});
  const perRound=tournament.competitions.flatMap(c=>require('../services/playerExperience').roundSummaries(allMatches.filter(m=>m.competitionId===c.id),allRounds.filter(r=>r.competitionId===c.id)).filter(r=>r.completed&&r.saved>0).map(r=>({...r,competition:c.name})));
  const bestRound=perRound.sort((a,b)=>b.points-a.points)[0]||null;
  const complete=tournament.competitions.length>0&&tournament.competitions.every(c=>c.podiumResolvedAt);
  res.json({tournamentName:tournament.name,complete,bestRound,progress,ranking:rows.find(r=>r.id===userId),players:rows.length,played:predictions.length,exact,winners,accuracy:predictions.length?Math.round(winners*100/predictions.length):null});
 }catch{res.status(500).json({error:'Bilan indisponible.'});}
});
module.exports=router;
