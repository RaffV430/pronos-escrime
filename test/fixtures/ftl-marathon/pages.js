const samples = require('./cadettes-samples.json');
const eventId = '68FE1711590744309544DA1492837F7C';
const url = (sample) => `https://www.fencingtimelive.com/pools/scores/${eventId}/${sample.source}`;
const config = { tournament: 'Marathon Fleuret 2026', event: "Cadet Women's Foil",
  eventTime: 'Saturday, January 31, 2026 8:00 AM', date: '2026-01-31', timezone: 'Europe/Paris',
  eventId, format: 'INDIVIDUAL', poolSources: [url(samples[0])] };
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
function page(sample, visible = samples, partial = false) {
 return `<span class="desktop tournName">${config.tournament}</span><span class="desktop eventName">${config.event}</span><span class="desktop eventTime">${config.eventTime}</span>${visible.map(s=>`<a href="${url(s)}">Pools</a>`).join('')}<div><h4 class="poolNum">Pool #1</h4><span class="poolStripTime">On strip 6 at 8:00 AM</span><table class="poolTable"><thead><tr class="poolHeader"><th></th><th></th>${sample.rows.map((_,i)=>`<th>${i+1}</th>`).join('')}</tr></thead><tbody>${sample.rows.map(([name,cells,stats],i)=>`<tr class="poolRow"><td><span class="poolCompName">${escape(name)}</span></td><td class="poolPos">${i+1}</td>${cells.map((x,j)=>`<td>${partial && i===0 && j===1 ? '' : escape(x)}</td>`).join('')}${stats.map(x=>`<td class="poolResult">${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
module.exports = { samples, url, config, page, eventId };
