const router=require('express').Router(),db=require('../lib/prisma');
const push=require('../services/pushNotifications');
const {rateLimit}=require('express-rate-limit');
router.use(require('../middleware/auth'));
router.use(rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Trop de demandes de notification. Réessayez dans une minute.'}}));
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Notifications temporairement indisponibles.'});}};
router.get('/config',wrap(async(req,res)=>res.json({available:push.configured(),publicKey:push.configured()?process.env.VAPID_PUBLIC_KEY:null})));
router.get('/choices',wrap(async(req,res)=>res.json(await db.tournament.findMany({select:{id:true,name:true,competitions:{select:{id:true,name:true},orderBy:{name:'asc'}}},orderBy:{createdAt:'desc'}}))));
router.post('/status',wrap(async(req,res)=>{
 const row=typeof req.body.endpoint==='string'?await db.pushSubscription.findFirst({where:{endpoint:req.body.endpoint,userId:req.user.userId},select:{id:true,enabled:true,tournamentIds:true,competitionIds:true,preferences:true}}):null;if(row){const [sent,failed]=await Promise.all([db.pushDelivery.findFirst({where:{subscriptionId:row.id,status:'SENT'},orderBy:{sentAt:'desc'},select:{sentAt:true}}),db.pushDelivery.count({where:{subscriptionId:row.id,status:'FAILED',createdAt:{gte:new Date(Date.now()-86400000)}}})]);row.preferences=require('../services/playerExperience').preferences(row.preferences||{});row.diagnostic={sentAt:sent?.sentAt||null,failed:failed>0};}res.json(row);
}));
router.post('/subscribe',wrap(async(req,res)=>{if(!push.configured())return res.status(503).json({error:'Notifications en cours de configuration.'});res.json(await push.subscribe(db,req.user.userId,req.body));}));
router.post('/disable',wrap(async(req,res)=>{
 if(typeof req.body.endpoint!=='string')return res.status(400).json({error:'Appareil non reconnu.'});
 await db.$transaction(async tx=>{const row=await tx.pushSubscription.findFirst({where:{endpoint:req.body.endpoint,userId:req.user.userId}});if(!row)return;await tx.$queryRaw`SELECT id FROM "PushSubscription" WHERE id=${row.id} FOR UPDATE`;await tx.pushSubscription.update({where:{id:row.id},data:{enabled:false}});await tx.pushDelivery.updateMany({where:{subscriptionId:row.id,status:{in:['PENDING','SENDING']}},data:{status:'CANCELLED'}});});res.json({enabled:false});
}));
router.get('/devices',wrap(async(req,res)=>{const rows=await db.pushSubscription.findMany({where:{userId:req.user.userId,enabled:true},select:{id:true,endpoint:true,updatedAt:true}});res.json(rows.map(r=>({id:r.id,label:r.endpoint.startsWith('https://web.push.apple.com/')?'Appareil Apple':'Navigateur',updatedAt:r.updatedAt})));}));
router.post('/test',rateLimit({windowMs:60000,limit:1,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Attendez une minute avant un nouveau test.'}}),wrap(async(req,res)=>{
 if(!push.configured())return res.status(503).json({error:'Notifications non configurées.'});
 const row=await db.pushSubscription.findFirst({where:{...(typeof req.body.subscriptionId==='string'?{id:req.body.subscriptionId}:{endpoint:String(req.body.endpoint||'')}),userId:req.user.userId,enabled:true}});
 if(!row)return res.status(404).json({error:'Activez d’abord les notifications sur cet appareil.'});
 const testClosesAt=new Date(Date.now()+10*60000);
 const content={...require('../services/notificationText').matchNotificationText({name:'Test · Fleuret hommes'},'T32',[{startsAt:testClosesAt}],row.preferences?.timezone||'Europe/Paris'),tag:'pronos-test',url:'/'};
 try{await push.send(row,content,60);}catch(e){if([404,410].includes(e.statusCode))await db.pushSubscription.update({where:{id:row.id},data:{enabled:false}});return res.status(502).json({error:'Le service de notification a refusé ce test. Réactivez cet appareil.'});}res.json({sent:true,testClosesAt:testClosesAt.toISOString()});
}));
module.exports=router;
