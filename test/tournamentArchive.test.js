const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {eventComplete,scheduleFinished,archiveCompleted}=require('../src/services/tournamentArchive');
const complete=()=>({podiumResolvedAt:new Date(),resultsVerifiedAt:new Date(),officialPodium:{finalConfirmed:true},matches:[{id:1,round:'T2',isFinished:true}],pools:[{isFinal:true}],matchRounds:[{round:'T2',expectedMatchCount:1}]});
test('archive requires official podium, all pools, complete rounds and team bronze',()=>{
 const c=complete();assert.equal(eventComplete(c),true);assert.equal(eventComplete({...c,matches:[],matchRounds:[]}),true);
 for(const patch of [{resultsVerifiedAt:null},{podiumResolvedAt:null},{pools:[{isFinal:false}]},{matches:[{round:'T2',isFinished:false}]},{matchRounds:[{round:'T2',expectedMatchCount:2}]},{podiumFormat:'TEAM'}])assert.equal(eventComplete({...c,...patch}),false);
});
test('entire official schedule must be finished including events not imported',()=>{
 let html=fs.readFileSync(__dirname+'/fixtures/ftl-schedule.html','utf8');
 const source='https://www.fencingtimelive.com/tournaments/eventSchedule/37728717D8234487A9BA770AD4FA9492';
 assert.equal(scheduleFinished(html,source,'Europe/Istanbul').finished,false);
});
test('unfinished local event performs no official fetch and no archive',async()=>{
 let fetched=false;const db={tournament:{findMany:async()=>[{id:1,competitions:[{...complete(),podiumResolvedAt:null}]}]}};
 assert.deepEqual(await archiveCompleted(db,{clientFactory:()=>{fetched=true}}),[]);assert.equal(fetched,false);
});
test('archive rechecks stored results under locks after all official events finish',async()=>{
 const {load}=require('cheerio'),{checkTournament}=require('../src/services/tournamentArchive');
 const $=load(fs.readFileSync(__dirname+'/fixtures/ftl-schedule.html','utf8'));
 $('tr[id^="ev_"]').each((_,r)=>$(r).children('td').eq(2).text('Finished at 6:00 PM'));
 const html=$.html(),source='https://www.fencingtimelive.com/tournaments/eventSchedule/37728717D8234487A9BA770AD4FA9492';
 const observation=scheduleFinished(html,source,'Europe/Istanbul');assert.equal(observation.finished,true);
 const e=observation.events[0],t={id:1,ftlSourceUrl:source,competitions:[{...complete(),id:1,name:e.event,ftlEventId:e.eventId}]};let updates=0,locked=0;
 const db={$queryRaw:async()=>{locked++;},tournament:{findUnique:async()=>t,update:async()=>{assert.equal(locked,2);updates++;}},ftlSyncState:{findMany:async()=>[],updateMany:async()=>{}},auditLog:{findFirst:async()=>({after:e}),create:async()=>{}}};db.$transaction=fn=>fn(db);
 assert.equal(await checkTournament(db,t,{login:async()=>{},get:async()=>html}),true);assert.equal(updates,1);
 db.tournament.findUnique=async()=>({...t,competitions:[{...t.competitions[0],resultsVerifiedAt:null}]});
 assert.equal(await checkTournament(db,t,{login:async()=>{},get:async()=>html}),false);assert.equal(updates,1);
});
