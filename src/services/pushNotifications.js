const webpush=require('web-push');
const {preferences,isQuiet,roundSummaries}=require('./playerExperience');
const {failure}=require('./ftlClient');
const {timedMatches}=require('./roundTiming');
const {matchClosed,closesAt}=require('../lib/matchLock');
function configured(){return Boolean(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT);}
function validateSubscription(input){
 let url;try{url=new URL(input?.endpoint);}catch{throw failure('Abonnement aux notifications invalide.',400);}
 const host=url.hostname;
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.href.length>2048||!(host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.push.services.mozilla.com')||host==='web.push.apple.com'||host.endsWith('.notify.windows.com')))throw failure('Service de notifications non reconnu.',400);
 for(const [key,size] of [['p256dh',65],['auth',16]])if(typeof input.keys?.[key]!=='string'||!/^[A-Za-z0-9_-]+$/.test(input.keys[key])||Buffer.from(input.keys[key],'base64url').length!==size)throw failure('Clé d’abonnement invalide.',400);
 if(Buffer.from(input.keys.p256dh,'base64url')[0]!==4)throw failure('Clé de navigateur invalide.',400);
 return {endpoint:url.href,p256dh:input.keys.p256dh,auth:input.keys.auth};
}
function validateScopes(input){
 const result={};
 for(const key of ['tournamentIds','competitionIds']){const values=input[key]||[];if(!Array.isArray(values)||values.length>128||values.some(v=>!Number.isSafeInteger(v)||v<1))throw failure('Sélection de notifications invalide.',400);result[key]=[...new Set(values)];}
 if(!result.tournamentIds.length&&!result.competitionIds.length)throw failure('Choisissez au moins un tournoi ou une épreuve.',400);
 return result;
}
async function subscribe(db,userId,input){
 const subscription=validateSubscription(input.subscription),scopes=validateScopes(input),prefs=preferences(input.preferences);
 const [t,c]=await Promise.all([db.tournament.count({where:{id:{in:scopes.tournamentIds}}}),db.competition.count({where:{id:{in:scopes.competitionIds}}})]);
 if(t!==scopes.tournamentIds.length||c!==scopes.competitionIds.length)throw failure('Une compétition sélectionnée n’existe plus.',409);
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184725)`;
  const current=await tx.pushSubscription.findUnique({where:{endpoint:subscription.endpoint}});
  if(current&&current.userId!==userId)throw failure('Cet appareil est associé à un autre compte. Réinitialisez son abonnement.',409);
  if(!current&&await tx.pushSubscription.count({where:{userId,enabled:true}})>=10)throw failure('Dix appareils sont déjà activés. Désactivez un ancien appareil.',409);
  const changed=JSON.stringify(current?.preferences)!==JSON.stringify(prefs)||!current?.enabled||JSON.stringify(current.tournamentIds)!==JSON.stringify(scopes.tournamentIds)||JSON.stringify(current.competitionIds)!==JSON.stringify(scopes.competitionIds);
  const latest=changed?await tx.pushEvent.findFirst({orderBy:{id:'desc'}}):null;
  if(current&&changed)await tx.pushDelivery.updateMany({where:{subscriptionId:current.id,status:{in:['PENDING','SENDING']}},data:{status:'CANCELLED'}});
  const row=await tx.pushSubscription.upsert({where:{endpoint:subscription.endpoint},create:{...subscription,...scopes,preferences:prefs,userId,lastEventId:latest?.id||0},update:{...subscription,...scopes,preferences:prefs,enabled:true,...(changed?{lastEventId:latest?.id||0,preferencesSince:new Date()}:{})}});
  return {id:row.id,enabled:row.enabled,preferences:prefs,...scopes};
 });
}
function follows(sub,c){return sub.tournamentIds.includes(c.tournamentId)||sub.competitionIds.includes(c.id);}
async function queueForSubscription(db,id){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184725)`;
  await tx.$queryRaw`SELECT id FROM "PushSubscription" WHERE id=${id} FOR UPDATE`;
  const sub=await tx.pushSubscription.findUnique({where:{id}});if(!sub?.enabled)return;
  const events=await tx.pushEvent.findMany({where:{id:{gt:sub.lastEventId}},orderBy:{id:'asc'},take:500});if(!events.length)return;
  const throughEventId=events.at(-1).id;
  const competitions=await tx.competition.findMany({where:{id:{in:[...new Set(events.map(e=>e.competitionId))]}}});
  for(const c of competitions.filter(c=>follows(sub,c))){
   const matches=await timedMatches(tx,await tx.match.findMany({where:{competitionId:c.id}}));
   const candidateIds=new Set(events.filter(e=>e.competitionId===c.id&&Date.now()-e.createdAt.getTime()<3600000).map(e=>e.matchId));
   const matchIds=matches.filter(m=>candidateIds.has(m.id)&&!matchClosed(m)).map(m=>m.id);
   if(matchIds.length&&preferences(sub.preferences||{}).newMatches&&!isQuiet(sub.preferences))await tx.pushDelivery.create({data:{subscriptionId:sub.id,competitionId:c.id,throughEventId,matchIds}});
  }
  await tx.pushSubscription.update({where:{id},data:{lastEventId:throughEventId}});
 },{timeout:15000});
}
function payload(c,matches,id){return {title:`${matches.length} nouveau${matches.length>1?'x':''} match${matches.length>1?'s':''} à pronostiquer`,body:c.name,tag:`pronos-${id}`,url:`/?tournament=${c.tournamentId}&event=${c.id}&new=1&matches=${matches.slice(0,64).map(m=>m.id).join(',')}`};}
async function send(subscription,content,ttl){return webpush.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth}},JSON.stringify(content),{TTL:ttl,timeout:7000,urgency:'normal',vapidDetails:{subject:process.env.VAPID_SUBJECT,publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY}});}
async function deliver(db,id,sender=send){
 const delivery=await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "PushDelivery" WHERE id=${id} FOR UPDATE`;
  const row=await tx.pushDelivery.findUnique({where:{id},include:{subscription:true}});
  if(!row||row.status!=='PENDING'||row.nextAttemptAt>Date.now())return null;
  await tx.pushDelivery.update({where:{id},data:{status:'SENDING',claimedAt:new Date(),attempts:{increment:1}}});return row;
 });
 if(!delivery)return;
 const sub=await db.pushSubscription.findUnique({where:{id:delivery.subscriptionId}}),c=await db.competition.findUnique({where:{id:delivery.competitionId}});
 const matches=c?await timedMatches(db,await db.match.findMany({where:{competitionId:c.id}})):[];
 const open=matches.filter(m=>delivery.matchIds.includes(m.id)&&!matchClosed(m));
 if((delivery.kind||'MATCHES')!=='MATCHES')return deliverSpecial(db,delivery,sub,c,matches,sender);
 if(!sub?.enabled||!preferences(sub.preferences||{}).newMatches||!c||!follows(sub,c)||!open.length||Date.now()-delivery.createdAt.getTime()>900000){await db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:'CANCELLED'}});return;}
 if(isQuiet(sub.preferences)){await db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:'CANCELLED'}});return;}
 const deadlines=open.map(closesAt).filter(Boolean).map(Date.parse);
 const ttl=Math.max(1,Math.min(900,...deadlines.map(d=>Math.floor((d-Date.now())/1000))));
 try{await sender(sub,payload(c,open,id),ttl);await db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:'SENT',sentAt:new Date()}});}
 catch(e){
  if([404,410].includes(e.statusCode))await db.pushSubscription.update({where:{id:sub.id},data:{enabled:false}});
  const retry=![400,401,403,404,410].includes(e.statusCode)&&delivery.attempts<3;
  await db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:retry?'PENDING':'FAILED',nextAttemptAt:new Date(Date.now()+60000*2**delivery.attempts)}});
 }
}

async function queueSpecial(db,id){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "PushSubscription" WHERE id=${id} FOR UPDATE`;
  const sub=await tx.pushSubscription.findUnique({where:{id}});if(!sub?.enabled)return;
  const p=preferences(sub.preferences||{});if((!p.reminders&&!p.roundResults)||isQuiet(p))return;
  const competitions=await tx.competition.findMany({where:{OR:[{id:{in:sub.competitionIds}},{tournamentId:{in:sub.tournamentIds}}]}});
  for(const c of competitions){
   const raw=await tx.match.findMany({where:{competitionId:c.id},include:{predictions:{where:{userId:sub.userId}}}}),matches=await timedMatches(tx,raw);
   const rounds=await tx.matchRound.findMany({where:{competitionId:c.id}});
   const recaps=roundSummaries(matches,rounds);
   for(const round of rounds){
    const missing=matches.filter(m=>m.round===round.round&&!m.predictions.length&&!matchClosed(m)&&closesAt(m)&&Date.parse(closesAt(m))-Date.now()<=900000);
    const recap=recaps.find(r=>r.round===round.round);
    const recent=recap?.completedAt&&Date.parse(recap.completedAt)>=Math.max(Date.now()-86400000,new Date(sub.preferencesSince||sub.createdAt).getTime());
    for(const [kind,active,ids] of [['REMINDER',p.reminders&&missing.length,missing.map(m=>m.id)],['ROUND',p.roundResults&&recap?.completed&&recap.saved>0&&recent,[]]]){
     if(!active)continue;
     await tx.pushDelivery.upsert({where:{subscriptionId_competitionId_throughEventId_kind_round:{subscriptionId:id,competitionId:c.id,throughEventId:0,kind,round:round.round}},create:{subscriptionId:id,competitionId:c.id,throughEventId:0,kind,round:round.round,matchIds:ids},update:{}});
    }
   }
  }
 },{timeout:20000});
}
async function deliverSpecial(db,delivery,sub,c,matches,sender){
 const {id,kind,round}=delivery;
 const cancel=()=>db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:'CANCELLED'}});
 if(!sub?.enabled||!c||!follows(sub,c))return cancel();
 const prefs=preferences(sub.preferences||{});
 if(isQuiet(prefs)||(kind==='REMINDER'&&!prefs.reminders)||(kind==='ROUND'&&!prefs.roundResults))return cancel();
 let content,ttl;
 if(kind==='REMINDER'){
  const predictions=await db.prediction.findMany({where:{userId:sub.userId,matchId:{in:matches.map(m=>m.id)}},select:{matchId:true}}),saved=new Set(predictions.map(p=>p.matchId));
  const missing=matches.filter(m=>m.round===round&&!saved.has(m.id)&&!matchClosed(m)&&closesAt(m)&&Date.parse(closesAt(m))-Date.now()<=900000);
  if(!missing.length||Date.now()-delivery.createdAt.getTime()>900000)return cancel();
  ttl=Math.max(1,Math.min(900,...missing.map(m=>Math.floor((Date.parse(closesAt(m))-Date.now())/1000))));
  content={title:`${round} : derniers pronostics`,body:`${missing.length} rencontre(s) à compléter · ${c.name}`,tag:`pronos-${id}`,url:`/?tournament=${c.tournamentId}&event=${c.id}&new=1&matches=${missing.slice(0,64).map(m=>m.id).join(',')}`};
 }else if(kind==='ROUND'){
  if(Date.now()-delivery.createdAt.getTime()>86400000)return cancel();
  const raw=await db.match.findMany({where:{competitionId:c.id},include:{predictions:{where:{userId:sub.userId}}}}),rounds=await db.matchRound.findMany({where:{competitionId:c.id}});
  const recap=roundSummaries(raw,rounds).find(r=>r.round===round);if(!recap?.completed||!recap.saved)return cancel();
  ttl=3600;content={title:`${round} terminé : ${recap.points} points`,body:`${recap.exact} score(s) exact(s), ${recap.winners} bon(s) vainqueur(s) · ${c.name}`,tag:`pronos-${id}`,url:`/?tournament=${c.tournamentId}&event=${c.id}&view=mine`};
 }else return cancel();
 try{await sender(sub,content,ttl);await db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:'SENT',sentAt:new Date()}});}
 catch(e){if([404,410].includes(e.statusCode))await db.pushSubscription.update({where:{id:sub.id},data:{enabled:false}});const retry=![400,401,403,404,410].includes(e.statusCode)&&delivery.attempts<3;await db.pushDelivery.updateMany({where:{id,status:'SENDING'},data:{status:retry?'PENDING':'FAILED',nextAttemptAt:new Date(Date.now()+60000*2**delivery.attempts)}});}
}
let running=false;
async function dispatch(db,sender=send){
 if(running)return;running=true;
 try{
  // Resume interrupted sends with the same notification tag, never a new event.
  await db.pushDelivery.updateMany({where:{status:'SENDING',claimedAt:{lt:new Date(Date.now()-120000)}},data:{status:'PENDING'}});
  const subs=await db.pushSubscription.findMany({where:{enabled:true},select:{id:true}});
  for(const sub of subs){await queueForSubscription(db,sub.id);await queueSpecial(db,sub.id);}
  const pending=await db.pushDelivery.findMany({where:{status:'PENDING',nextAttemptAt:{lte:new Date()}},select:{id:true},orderBy:{createdAt:'asc'},take:100});
  let index=0;await Promise.all(Array.from({length:4},async()=>{while(index<pending.length){const item=pending[index++];try{await deliver(db,item.id,sender);}catch{console.warn('Envoi de notification à réessayer.');}}}));
 }finally{running=false;}
}
function startWorker(db){if(!configured())return()=>{};const tick=()=>dispatch(db).catch(()=>console.warn('Notifications temporairement indisponibles.'));const timer=setInterval(tick,30000);timer.unref();tick();return()=>clearInterval(timer);}
module.exports={queueSpecial,deliverSpecial,configured,validateSubscription,validateScopes,subscribe,follows,queueForSubscription,payload,deliver,dispatch,startWorker,send};
