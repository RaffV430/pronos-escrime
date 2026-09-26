const test=require('node:test');
const assert=require('node:assert/strict');
const {validateSelection,verifiedPodium,podiumPoints,predictionIds,resolvePodium}=require('../src/services/podiumRules');
const source='A'.repeat(32);
const fixture=format=>({podiumFormat:format,podiumRoster:[{id:'a',name:'DUPONT Alice',country:'FRA'},{id:'b',name:'DUPONT Alice',country:'BEL'},{id:'c',name:'DUPONT Bob',country:'FRA'},{id:'d',name:'DURAND Clara',country:'FRA'},{id:'e',name:'MARTIN Eva',country:'FRA',active:false}],rosterSourceUrl:`https://www.fencingtimelive.com/events/competitors/${source}`,resultsSourceUrl:`https://www.fencingtimelive.com/events/results/${source}`,resultsVerifiedAt:new Date()});
test('resolution locks before reading predictions and recalculates corrections without accumulating points',async()=>{
 const c={...fixture('TEAM'),officialPodium:{gold:'a',silver:'b',bronze1:'c',finalConfirmed:true,bronzeMatchConfirmed:true}};
 const prediction={id:7,selectionIds:{gold:'a',silver:'b',bronze1:'c'},pointsEarned:0};let locked=false;
 const tx={$queryRaw:async()=>{locked=true;},competition:{findUnique:async()=>{assert.ok(locked);return c;},update:async({data})=>Object.assign(c,data)},podiumPrediction:{findMany:async()=>{assert.ok(locked);return [prediction];},update:async({where,data})=>{assert.equal(where.id,7);Object.assign(prediction,data);}}};
 await resolvePodium(tx,1);assert.equal(prediction.pointsEarned,45);
 await resolvePodium(tx,1);assert.equal(prediction.pointsEarned,45);
 c.officialPodium={...c.officialPodium,gold:'b',silver:'a'};
 await resolvePodium(tx,1);assert.equal(prediction.pointsEarned,25);assert.equal(c.isPodiumLocked,true);
});
test('individual bronzes are interchangeable; team has one bronze and max45',()=>{
 const official={gold:'a',silver:'b',bronze1:'c',bronze2:'d'};
 assert.equal(podiumPoints('INDIVIDUAL',{gold:'a',silver:'b',bronze1:'d',bronze2:'c'},official),60);
 assert.equal(podiumPoints('TEAM',{gold:'a',silver:'b',bronze1:'c'},official),45);
 assert.equal(podiumPoints('TEAM',{gold:'b',silver:'a',bronze1:'d'},official),10);
 assert.equal(podiumPoints('INDIVIDUAL',{gold:'b',silver:'a',bronze1:'c',bronze2:'x'},official),25);
});
test('selection distinguishes full-name homonyms and rejects outsiders, repeated IDs and second team bronze',()=>{
 const c=fixture('INDIVIDUAL');
 assert.equal(validateSelection(c,{gold:'a',silver:'b',bronze1:'c',bronze2:'d'}).ids.silver,'b');
 for(const p of [{gold:'a',silver:'a',bronze1:'c',bronze2:'d'},{gold:'other-event',silver:'b',bronze1:'c',bronze2:'d'},{gold:'e',silver:'b',bronze1:'c',bronze2:'d'}]) assert.throws(()=>validateSelection(c,p));
 assert.throws(()=>validateSelection(fixture('TEAM'),{gold:'a',silver:'b',bronze1:'c',bronze2:'d'}));
 assert.throws(()=>predictionIds(c,{id:1,gold:'DUPONT Alice',silver:'DUPONT Bob',bronze1:'DURAND Clara',bronze2:'MARTIN Eva'}),/ambigu/);
});
test('points require verified Results from same event, final and team bronze match',()=>{
 const c=fixture('TEAM'); c.officialPodium={gold:'a',silver:'b',bronze1:'c'};
 assert.throws(()=>verifiedPodium(c),/attente/);
 c.officialPodium.finalConfirmed=true;assert.throws(()=>verifiedPodium(c));
 c.officialPodium.bronzeMatchConfirmed=true;assert.equal(verifiedPodium(c).bronze1,'c');
 c.resultsSourceUrl=c.resultsSourceUrl.replace(source,'B'.repeat(32));assert.throws(()=>verifiedPodium(c));
 c.resultsSourceUrl=`https://www.fencingtimelive.com/events/results/${source}`;c.resultsVerifiedAt=null;assert.throws(()=>verifiedPodium(c));
});
