const router=require('express').Router();
const prisma=require('../lib/prisma');
const {id,fail}=require('../services/poolRules');
router.use(require('../middleware/auth'),require('../middleware/admin'));
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Opération impossible.'});}};
router.get('/users',wrap(async(req,res)=>{
 const q=String(req.query.q||'').trim();if(q.length<2&&!/^[1-9]$/.test(q))return res.json([]);
 res.json(await prisma.user.findMany({where:/^[1-9]\d*$/.test(q)?{id:id(q)}:{name:{contains:q,mode:'insensitive'}},select:{id:true,name:true},take:20,orderBy:{name:'asc'}}));
}));
router.get('/audit',wrap(async(req,res)=>res.json(await prisma.auditLog.findMany({orderBy:{id:'desc'},take:100}))));
router.get('/adjustments',wrap(async(req,res)=>res.json(await prisma.pointAdjustment.findMany({orderBy:{id:'desc'},take:100,include:{user:{select:{name:true}}}}))));
router.post('/adjust-points',wrap(async(req,res)=>{
 const key=req.body.requestKey;
 if(typeof key!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(key))fail('Identifiant de demande requis. Réessayez depuis le formulaire.');
 const points=typeof req.body.points==='string'&&/^-?\d+$/.test(req.body.points)?Number(req.body.points):req.body.points;
 if(!Number.isInteger(points)||!points||Math.abs(points)>10000)fail('Nombre de points non nul entre -10000 et 10000 requis.');
 const userId=req.body.userId?id(req.body.userId):null, name=String(req.body.name||'').normalize('NFC').trim();
 if((!userId&&!name)||(userId&&name))fail('Choisissez un joueur par ID ou par nom.');
 const competitionId=req.body.competitionId?id(req.body.competitionId):null;
 let tournamentId=req.body.tournamentId?id(req.body.tournamentId):null;
 const reason=String(req.body.reason||'').trim();if(reason.length<3||reason.length>250)fail('Indiquez une raison entre 3 et 250 caractères.');
 const result=await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${req.user.userId} FOR UPDATE`;
  const previous=await tx.pointAdjustment.findUnique({where:{requestKey:key}});
  const users=await tx.user.findMany({where:userId?{id:userId}:{name:{equals:name,mode:'insensitive'}},select:{id:true,name:true}});
  if(users.length!==1)fail(users.length?'Nom ambigu : utilisez l’ID.':'Joueur introuvable.',users.length?409:404);
  if(competitionId){const c=await tx.competition.findUnique({where:{id:competitionId}});if(!c)fail('Épreuve introuvable.',404);if(tournamentId&&c.tournamentId!==tournamentId)fail('Cette épreuve ne correspond pas au tournoi.');tournamentId=c.tournamentId;}
  else if(tournamentId&&!await tx.tournament.findUnique({where:{id:tournamentId}}))fail('Tournoi introuvable.',404);
  if(previous){if(previous.actorId!==req.user.userId||previous.userId!==users[0].id||previous.points!==points||previous.reason!==reason||previous.competitionId!==competitionId||previous.tournamentId!==tournamentId)fail('Cette demande a déjà été utilisée avec un autre contenu.',409);return previous;}
  const adjustment=await tx.pointAdjustment.create({data:{userId:users[0].id,points,reason,tournamentId,competitionId,requestKey:key,actorId:req.user.userId}});
  await tx.auditLog.create({data:{actorId:req.user.userId,action:'Ajustement de points',targetType:'PointAdjustment',targetId:adjustment.id,after:{userId:users[0].id,points,reason,tournamentId,competitionId}}});
  return adjustment;
 });
 res.json({success:true,adjustment:result});
}));
router.post('/ftl/preview',wrap(async(req,res)=>res.json(await require('../services/ftlConfiguration').preview(prisma,req.body,req.user.userId))));
router.post('/ftl/configure',wrap(async(req,res)=>res.json(await require('../services/ftlConfiguration').save(prisma,req.body,req.user.userId))));
router.get('/ftl/configuration/:competitionId',wrap(async(req,res)=>res.json(await require('../services/ftlConfiguration').configuration(prisma,id(req.params.competitionId)))));
module.exports=router;
