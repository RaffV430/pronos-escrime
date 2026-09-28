const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {parsePools}=require('../src/services/ftlPools');
const html=fs.readFileSync(__dirname+'/fixtures/cism-pools-corrected.html','utf8');
test('official absence has no invented bouts, six active fencers remain complete',()=>{
 const [one,seven]=parsePools(html);assert.equal(one.complete,true);assert.equal(one.rows.length,6);assert.equal(seven.complete,true);assert.equal(seven.rows.length,7);
 const absent=seven.rows[6];assert.equal(absent.absent,true);assert.equal(absent.hasResult,false);assert.equal(absent.firstResult,false);assert.equal(absent.wins,null);assert.equal(absent.indicator,null);
 assert.deepEqual(seven.rows.slice(0,6).map(r=>[r.wins,r.losses,r.indicator]),[[3,2,5],[0,5,-20],[4,1,4],[2,3,1],[3,2,8],[3,2,2]]);
});
test('unrecognized absence and scores against absent fencer remain rejected',()=>{
 assert.throws(()=>parsePools(html.replace('Failed to Appear','Unknown withdrawal')));
 assert.throws(()=>parsePools(html.replace('<td class="poolScoreWDX"></td>','<td class="poolScoreWDX">V5</td>')));
});
