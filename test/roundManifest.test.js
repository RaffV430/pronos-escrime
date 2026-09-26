const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateManifest}=require('../src/services/roundManifest');
const rounds=[{round:'T8',previousRound:null,expectedMatchCount:3},{round:'T4',previousRound:'T8',expectedMatchCount:2},{round:'T2',previousRound:'T4',expectedMatchCount:1},{round:'Bronze',previousRound:'T4',expectedMatchCount:1}];
test('manifest allows byes and separates bronze from final',()=>assert.equal(validateManifest(rounds).length,4));
test('manifest rejects partial chain, cycles, duplicate rounds and impossible counts',()=>{
 assert.throws(()=>validateManifest(rounds.slice(1)));
 assert.throws(()=>validateManifest([...rounds,rounds[0]]));
 assert.throws(()=>validateManifest(rounds.map(r=>r.round==='T8'?{...r,previousRound:'T2'}:r)));
 assert.throws(()=>validateManifest(rounds.map(r=>r.round==='T8'?{...r,expectedMatchCount:5}:r)));
});
