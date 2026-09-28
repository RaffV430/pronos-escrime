const {test}=require('node:test'),assert=require('node:assert/strict');
const {countryFor,withCountries}=require('../src/services/matchCountries');
test('nationality requires unique full-name match, preserves identities and converts sporting codes',()=>{
 const r=[{name:'SPICA MANUELA',country:'ITA'},{name:'DOE Jane',country:'GER'}];
 assert.equal(countryFor(r,' spica  Manuela '),'ITA');assert.equal(countryFor(r,'DOE Jane'),'DEU');assert.equal(countryFor(r,'SPICA'),null);
 assert.equal(countryFor([...r,r[0]],'SPICA MANUELA'),null);assert.equal(countryFor(null,'X'),null);
 const m=withCountries({id:1,player1:'SPICA MANUELA',player2:'Unknown',competition:{name:'Event',podiumRoster:r}});
 assert.equal(m.player1,'SPICA MANUELA');assert.equal(m.player1Country,'ITA');assert.equal(m.player2Country,null);assert.equal(m.competition.podiumRoster,undefined);
});
