const {test}=require('node:test');
const assert=require('node:assert/strict');
const {matchClosed,closesAt,roundContext,podiumClosed}=require('../src/lib/matchLock');
const start=Date.parse('2026-09-27T06:00:00Z');
const iso=n=>new Date(n).toISOString();
const rounds=[{competitionId:1,round:'T32',previousRound:null,expectedMatchCount:2},{competitionId:1,round:'T16',previousRound:'T32',expectedMatchCount:8}];
const prior=[{id:1,competitionId:1,round:'T32',isFinished:true,resultRegisteredAt:iso(start)},{id:2,competitionId:1,round:'T32',isFinished:false}];
const next={id:3,competitionId:1,round:'T16',startsAt:iso(start-1000)};
test('first round closes exactly at start',()=>{
 const [m]=roundContext([{...next,round:'T32'}],rounds);
 assert.equal(closesAt(m),next.startsAt);assert.equal(matchClosed(m,start-1001),false);assert.equal(matchClosed(m,start-1000),true);
});
test('known pair stays open until every previous result is registered',()=>{
 for(const predecessors of [prior,prior.slice(0,1)]){
  const m=roundContext([...predecessors,next],rounds).at(-1);
  assert.equal(m.awaitingPreviousRound,true);assert.equal(closesAt(m),null);assert.equal(matchClosed(m,start+3600000),false);
 }
});
test('one common grace starts at LAST result, regardless of each pair',()=>{
 const matches=[prior[0],{...prior[1],isFinished:true,resultRegisteredAt:iso(start+300000)},next,{...next,id:4}];
 const result=roundContext(matches,rounds).slice(2);
 for(const m of result){assert.equal(closesAt(m),iso(start+900000));assert.equal(matchClosed(m,start+899999),false);assert.equal(matchClosed(m,start+900000),true);}
 assert.equal(closesAt({...result[0],startsAt:iso(start+1800000)}),iso(start+1800000));
});
test('unknown manifest, missing timestamp, foreign competition never imply completion',()=>{
 for(const rows of [[],rounds]){
 const m=roundContext([{...prior[0],resultRegisteredAt:null},{...prior[1],competitionId:2,isFinished:true,resultRegisteredAt:iso(start)},next],rows).at(-1);
 assert.equal(m.timingUnverified||m.awaitingPreviousRound,true);
 }
});
test('manual override expires at exactly 10 minutes even during incomplete previous round',()=>{
 const m={...next,isLocked:true,awaitingPreviousRound:true,manualUnlockUntil:iso(start+600000)};
 assert.equal(matchClosed(m,start+599999),false);assert.equal(matchClosed(m,start+600000),true);
 assert.equal(matchClosed({...m,isFinished:true},start),true);
 assert.equal(matchClosed({...m,manualUnlockUntil:null,manualUnlock:true},start),true);
});
test('podium closes with first round, independent of later round',()=>{
 assert.equal(podiumClosed({},[{round:'T32',startsAt:iso(start)},{round:'T16',isLocked:true}],start-1),false);
 assert.equal(podiumClosed({},[{round:'T32',startsAt:iso(start)}],start),true);
});
