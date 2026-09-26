const {test}=require('node:test'),assert=require('node:assert/strict');
const {rankRows}=require('../src/services/ranking');
const {challengePoints,clubScore}=require('../src/services/communityRules');
test('tied scores share competition ranks without changing points',()=>{
 assert.deepEqual(rankRows([{name:'Z',totalPoints:9},{name:'A',totalPoints:9},{name:'B',totalPoints:4}]).map(r=>[r.name,r.rank]),[['A',1],['Z',1],['B',3]]);
});
test('clubs count zero scorers in average and never benefit merely from size',()=>{
 const rows=[{id:1,totalPoints:12},{id:2,totalPoints:6},{id:3,totalPoints:0}];
 assert.equal(clubScore([{userId:1},{userId:2},{userId:3}],rows),6);
 assert.equal(clubScore([{userId:1},{userId:2},{userId:3},{userId:1},{userId:2},{userId:3}],rows),6);
});
test('challenge bonus requires a final; corrections and medical winners are respected',()=>{
 assert.equal(challengePoints({winner:1},{isFinished:false,winner:1}),0);
 assert.equal(challengePoints({winner:1},{isFinished:true,score1:15,score2:9}),3);
 assert.equal(challengePoints({winner:1},{isFinished:true,score1:9,score2:15}),0);
 assert.equal(challengePoints({winner:2},{isFinished:true,score1:null,score2:null,winner:2,resultType:'MEDICAL_WITHDRAWAL'}),3);
});
