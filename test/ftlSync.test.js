const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {load}=require('cheerio');
const {parseTable}=require('../src/services/ftlParser');
const {planMatches,applyObservation,syncCompetition,podiumFromResults}=require('../src/services/ftlSync');
const {createClient}=require('../src/services/ftlClient');
const fixture=name=>fs.readFileSync(`${__dirname}/fixtures/${name}`,'utf8');
function options(html){const $=load(html);return {date:'2026-09-27',roster:[...new Set($('.tbb,.tbbr').toArray().map(e=>$(e).find('.tcln,.tcfn').map((i,n)=>$(n).text()).get().join(' ').replace(/\s+/g,' ').trim()).filter(n=>n&&n!=='- BYE -'))].map(name=>({name}))};}
test('official team table preserves BYE slots, future empty rounds and Istanbul time',()=>{
 const html=fixture('ftl-team.html'),r=parseTable(html,options(html));
 assert.equal(r.matches.length,8);assert.equal(r.matches[0].sourceKey,'Table of 32:2');
 assert.equal(r.matches[0].startsAt.toISOString(),'2026-09-27T06:00:00.000Z');
 assert.deepEqual(r.rounds.map(r=>r.expectedMatchCount),[7,8,4,2,1]);
 assert.ok(r.matches.every(m=>!m.isFinished));
 assert.throws(()=>parseTable(html,{...options(html),roster:[]}),/absent/);
});
test('official individual table attaches scores to correct winner cell, including medical withdrawal',()=>{
 const html=fixture('ftl-individual-partial.html'),r=parseTable(html,{...options(html),maxScore:15,requireComplete:false});
 assert.equal(r.matches[0].score1,15);assert.equal(r.matches[0].score2,10);
 assert.equal(r.matches[1].score1,8);assert.equal(r.matches[1].score2,15);
 const medical=r.matches.find(m=>m.resultType==='MEDICAL_WITHDRAWAL');
 assert.equal(medical.player1,'KURASBEDIANI Mariam');assert.equal(medical.winner,1);assert.equal(medical.isFinished,true);assert.equal(medical.score1,null);
 assert.throws(()=>parseTable(html,options(html)),/derniers tours/);
});
test('reconciliation never changes adversaries, loses an existing match, or removes a final result',()=>{
 const m={id:1,sourceKey:'Finals:1',sourceUrl:'source',round:'T2',player1:'Alice A',player2:'Bob B',isFinished:true};
 const observed={...m,isFinished:true};
 assert.equal(planMatches([m],{sourceUrl:'source',matches:[observed]})[0].current.id,1);
 assert.throws(()=>planMatches([m],{sourceUrl:'source',matches:[{...observed,player2:'Charlie C'}]}),/adversaires/);
 assert.throws(()=>planMatches([m],{sourceUrl:'source',matches:[{...observed,isFinished:false}]}),/retiré/);
 assert.throws(()=>planMatches([m],{sourceUrl:'source',matches:[]}),/figure plus/);
});
test('transaction preserves predictions, locks and result timestamp; recalculates idempotently',async()=>{
 const c={id:1,name:'Event',podiumFormat:'TEAM',podiumRoster:[],rosterSourceUrl:'roster'};
 const m={id:7,competitionId:1,sourceKey:'Finals:1',sourceUrl:'source',round:'T2',player1:'A',player2:'B',isLocked:true,isFinished:false,resultRegisteredAt:null};
 const p={id:2,matchId:7,predictedScore1:45,predictedScore2:30,pointsEarned:0};let locks=0;
 const db={$queryRaw:async()=>{locks++;return[];},competition:{findUnique:async()=>c},match:{findMany:async()=>[m],update:async({data})=>{assert.equal(locks,2);assert.ok(!('resultRegisteredAt'in data));Object.assign(m,data);return m;}},matchRound:{findMany:async()=>[],upsert:async()=>{}},prediction:{findMany:async()=>[p],update:async({data})=>Object.assign(p,data)},auditLog:{create:async()=>{}}};
 const observation={sourceUrl:'source',checkedAt:new Date(),rounds:[],warnings:[],matches:[{...m,isFinished:true,winner:1,score1:null,score2:null,resultType:'MEDICAL_WITHDRAWAL'}]};
 const a=await applyObservation(db,c,observation,1);assert.equal(a.results,1);assert.equal(p.pointsEarned,1);assert.equal(p.predictedScore1,45);assert.equal(p.predictedScore2,30);assert.equal(m.isLocked,true);
 locks=0;const b=await applyObservation(db,c,observation,1);assert.equal(b.results,0);assert.equal(b.pointsUpdated,0);assert.equal(p.pointsEarned,1);
});
test('event cooldown refuses a concurrent request before any login',async()=>{
 const db={tournament:{findUnique:async()=>({})},$queryRaw:async()=>[],competition:{findUnique:async()=>({id:1})},ftlSyncState:{upsert:async()=>({lastStartedAt:new Date()})}};db.$transaction=fn=>fn(db);
 await assert.rejects(syncCompetition(db,1,1,{login:()=>assert.fail('must not login')}),e=>e.status===429&&e.retryAfter>0);
});
test('dedicated client keeps cookies and password server-side and rejects external destinations',async()=>{
 const calls=[];const http={request:async cfg=>{calls.push(cfg);return cfg.url.endsWith('/account/login')?{status:200,headers:{'set-cookie':['test=one; Path=/; Secure']},data:'<meta name="csrf_token" content="test-csrf">'}:{status:200,headers:{},data:'ok'};}};
 const client=createClient({email:'dedicated@example.com',password:'test-only',http});await client.login();
 assert.equal(calls[1].url,'https://www.fencingtimelive.com/login');assert.equal(calls[1].headers.Cookie,'test=one');assert.equal(calls[1].headers['x-csrf-token'],'test-csrf');
 await assert.rejects(client.get('https://other.example/'),/non autorisée/);
});
test('podium needs final/bronze proof and exact entry ID plus full name',()=>{
 const c={podiumFormat:'TEAM',podiumRoster:['A','B','C'].map(name=>({id:name,name}))};
 const rows=['A','B','C'].map((name,i)=>({id:name,name,place:i+1}));
 const matches=[{round:'T2',isFinished:true,player1:'A',player2:'B',winner:1},{round:'Bronze',isFinished:true,player1:'C',player2:'D',winner:1}];
 assert.equal(podiumFromResults(rows,c,matches).bronze1,'C');assert.equal(podiumFromResults(rows,c,matches.slice(0,1)),null);
 assert.throws(()=>podiumFromResults([{...rows[0],name:'A homonym'},...rows.slice(1)],c,matches),/Identité/);
});

test('tied official score retains explicit advancing winner, never fabricates a touch',()=>{
 const html=fixture('ftl-individual-partial.html').replace('15 - 10','2 - 2');
 const r=parseTable(html,{...options(html),maxScore:15,requireComplete:false});
 assert.equal(r.matches[0].score1,2);assert.equal(r.matches[0].score2,2);assert.equal(r.matches[0].winner,1);assert.equal(r.matches[0].isFinished,true);
 const {calculateMatchPoints}=require('../src/services/matchPoints');
 assert.equal(calculateMatchPoints(15,10,2,2,1,'NORMAL'),1);
 assert.equal(calculateMatchPoints(10,15,2,2,1,'NORMAL'),0);
 assert.equal(calculateMatchPoints(15,10,2,2,null,'NORMAL'),0);
});
