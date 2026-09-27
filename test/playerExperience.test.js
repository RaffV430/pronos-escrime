const {test}=require('node:test'),assert=require('node:assert/strict');
const {preferences,isQuiet,roundSummaries,freshness}=require('../src/services/playerExperience');
const push=require('../src/services/pushNotifications');
test('new notification categories are opt-in and preferences reject invalid times/types',()=>{
 assert.equal(preferences().reminders,false);assert.equal(preferences().newMatches,true);
 for(const p of [{quietStart:'25:00'},{timezone:'invalid'},{roundResults:'true'},{quietEnabled:true,quietStart:'08:00',quietEnd:'08:00'}])assert.throws(()=>preferences(p));
});
test('quiet hours respect local timezone, overnight boundaries and daylight saving',()=>{
 const p={quietEnabled:true,quietStart:'22:00',quietEnd:'08:00',timezone:'Europe/Paris'};
 assert.equal(isQuiet(p,new Date('2026-09-28T20:00:00Z')),true);assert.equal(isQuiet(p,new Date('2026-09-28T06:00:00Z')),false);
 assert.equal(isQuiet(p,new Date('2026-12-28T20:30:00Z')),false);assert.equal(isQuiet(p,new Date('2026-12-28T21:00:00Z')),true);
 assert.equal(isQuiet({...p,quietStart:'12:00',quietEnd:'14:00'},new Date('2026-09-28T11:00:00Z')),true);
});
test('round recap ignores cancelled bouts and counts medical winners without exact bonuses',()=>{
 const m=(id,more)=>({id,round:'T4',isFinished:true,score1:15,score2:10,resultRegisteredAt:new Date(),predictions:[{predictedScore1:15,predictedScore2:10,pointsEarned:4}],...more});
 const rows=[m(1),m(2,{resultType:'MEDICAL_WITHDRAWAL',winner:1,score1:null,score2:null,predictions:[{predictedScore1:15,predictedScore2:0,pointsEarned:1}]}),m(3,{resultType:'CANCELLED'})];
 const [r]=roundSummaries(rows,[{round:'T4',expectedMatchCount:2}]);assert.equal(r.completed,true);assert.equal(r.points,5);assert.equal(r.exact,1);assert.equal(r.winners,2);
 assert.equal(roundSummaries(rows,[{round:'T4',expectedMatchCount:3}])[0].completed,false);
 assert.equal(roundSummaries([m(1,{syncIssue:'changed'})],[{round:'T4',expectedMatchCount:1}])[0].completed,false);
});
test('freshness distinguishes finished events, overdue checks and expired claims',()=>{
 const now=Date.now();assert.equal(freshness({status:'COMPLETE'}).state,'COMPLETE');
 assert.equal(freshness({status:'READY',nextAutomaticAt:new Date(now-240000)},now).state,'DELAYED');
 assert.equal(freshness({status:'RUNNING',leaseUntil:new Date(now-1)},now).state,'DELAYED');
 assert.equal(freshness({status:'RUNNING',leaseUntil:new Date(now+1000)},now).state,'RUNNING');
 assert.equal(freshness(null).state,'UNKNOWN');
});
test('round alerts are idempotent, per-device opt-in, and never backfill old rounds',async()=>{
 const sub={id:'s',userId:1,enabled:true,tournamentIds:[1],competitionIds:[],preferences:{roundResults:true},preferencesSince:new Date(Date.now()-1000)},del=[];
 const db={$queryRaw:async()=>[],pushSubscription:{findUnique:async()=>sub},competition:{findMany:async()=>[{id:5}]},match:{findMany:async()=>[{id:7,competitionId:5,round:'T2',isFinished:true,resultRegisteredAt:new Date(),score1:15,score2:10,predictions:[{predictedScore1:15,predictedScore2:10,pointsEarned:4}]}]},matchRound:{findMany:async()=>[{competitionId:5,round:'T2',expectedMatchCount:1}]},pushDelivery:{upsert:async({create})=>{if(!del.some(d=>d.kind===create.kind&&d.round===create.round))del.push(create);}}};db.$transaction=f=>f(db);
 await push.queueSpecial(db,'s');await push.queueSpecial(db,'s');assert.equal(del.length,1);assert.equal(del[0].kind,'ROUND');
 del.length=0;sub.preferencesSince=new Date(Date.now()+10000);await push.queueSpecial(db,'s');assert.equal(del.length,0);
 sub.preferences={};await push.queueSpecial(db,'s');assert.equal(del.length,0);
});
test('reminder send rechecks saved predictions and cancels instead of spamming',async()=>{
 let status='';const db={pushDelivery:{updateMany:async({data})=>{status=data.status;}},prediction:{findMany:async()=>[{matchId:7}]}};
 await push.deliverSpecial(db,{id:'d',kind:'REMINDER',round:'T2',createdAt:new Date()}, {enabled:true,userId:1,preferences:{reminders:true},tournamentIds:[1],competitionIds:[]},{id:5,tournamentId:1},[{id:7,round:'T2',startsAt:new Date(Date.now()+300000)}],()=>assert.fail('must not send'));
 assert.equal(status,'CANCELLED');
});
test('reminder includes only unsaved open matches and expires at their actual deadline',async()=>{
 let sent,status;const db={pushDelivery:{updateMany:async({data})=>{status=data.status;}},prediction:{findMany:async()=>[{matchId:8}]}};
 const start=new Date(Date.now()+300000),matches=[7,8,9].map(id=>({id,round:'T16',startsAt:start,isFinished:id===9}));
 await push.deliverSpecial(db,{id:'d',kind:'REMINDER',round:'T16',createdAt:new Date()},{enabled:true,userId:1,preferences:{reminders:true},tournamentIds:[1],competitionIds:[]},{id:5,tournamentId:1,name:'Épreuve'},matches,async(s,p,ttl)=>{sent=p;assert.ok(ttl<=300&&ttl>0);});
 assert.equal(status,'SENT');assert.match(sent.url,/matches=7$/);assert.match(sent.title,/T16/);
});
test('quiet hours suppress sends even when an alert was queued earlier',async()=>{
 let status;const db={pushDelivery:{updateMany:async({data})=>{status=data.status;}}};
 const hour=new Date().getUTCHours();const start=String(hour).padStart(2,'0')+':00',end=String((hour+1)%24).padStart(2,'0')+':00';
 await push.deliverSpecial(db,{id:'d',kind:'ROUND',round:'T2'}, {enabled:true,preferences:{roundResults:true,quietEnabled:true,quietStart:start,quietEnd:end,timezone:'UTC'},tournamentIds:[1],competitionIds:[]},{id:5,tournamentId:1},[],()=>assert.fail('quiet'));assert.equal(status,'CANCELLED');
});
