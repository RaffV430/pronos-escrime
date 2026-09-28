const {failure}=require('./ftlClient');
function localTime(date,hour,minute,timezone){
 const target=`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`,base=Date.parse(target+':00Z');
 const format=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 // Enumerate legal UTC offsets in 15-minute steps; reject DST gaps and ambiguous repeated times.
 const candidates=[];for(let offset=-12*60;offset<=14*60;offset+=15){const value=new Date(base-offset*60000);if(format.format(value).replace(' ','T')===target)candidates.push(value);}
 if(candidates.length!==1)throw failure('Horaire local ambigu ou inexistant dans ce fuseau. Vérification requise.');
 return candidates[0];
}
module.exports={localTime};
