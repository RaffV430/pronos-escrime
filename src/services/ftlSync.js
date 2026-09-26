const {load}=require('cheerio');
const {createClient,failure,ORIGIN}=require('./ftlClient');
const {parseTable,clean,norm}=require('./ftlParser');
const events=require('./ftlEvents');
const {configuration}=require('./ftlConfiguration');
const {parsePools,applyPool,pattern:poolPattern}=require('./ftlPools');
const {captureRankings}=require('./rankingHistory');
const {validateManifest}=require('./roundManifest');
const {calculateMatchPoints}=require('./matchPoints');
const podiumRules=require('./podiumRules');
const START='Contrôle FTL démarré',DONE='Contrôle FTL terminé',FAILED='Contrôle FTL échoué';
const COOLDOWN=120000;
const sourcePattern=/^https:\/\/www\.fencingtimelive\.com\/tableaus\/scores\/([a-f0-9]{32})\/[a-f0-9]{32}$/i;
const samePair=(a,b)=>norm(a.player1)===norm(b.player1)&&norm(a.player2)===norm(b.player2);
const pairKey=m=>[norm(m.player1),norm(m.player2)].sort().join('|');
function verifyPage(html,config){
 const $=load(html);
 if(norm($('.desktop.tournName').text())!==norm(config.tournament)||norm($('.desktop.eventName').text())!==norm(config.event)||norm($('.desktop.eventTime').text())!==norm(config.eventTime))throw failure('Identité ou date de l’épreuve officielle différente de la configuration.');
 return $;
}
function podiumFromResults(rows,c,matches){
 if(!Array.isArray(rows))throw failure('Classement officiel non reconnu.');
 const final=matches.find(m=>m.round==='T2'&&m.isFinished),bronze=matches.find(m=>m.round==='Bronze'&&m.isFinished);
 if(!final||(c.podiumFormat==='TEAM'&&!bronze))return null;
 const at=n=>rows.filter(r=>String(r.place).replace(/T$/,'')===String(n));
 if(at(1).length!==1||at(2).length!==1||at(3).length!==(c.podiumFormat==='TEAM'?1:2))throw failure('Médailles officielles non définitives ou ambiguës.');
 const entry=r=>{const found=c.podiumRoster.filter(e=>e.id===r.id&&norm(e.name)===norm(r.name));if(found.length!==1)throw failure('Identité du médaillé différente de la liste des engagés.');return found[0];};
 const gold=entry(at(1)[0]),silver=entry(at(2)[0]),third=at(3).map(entry);
 if(norm(gold.name)!==norm(final[`player${final.winner}`])||norm(silver.name)!==norm(final[`player${3-final.winner}`]))throw failure('Le classement final ne correspond pas à la finale.');
 if(bronze&&norm(third[0].name)!==norm(bronze[`player${bronze.winner}`]))throw failure('La médaille de bronze ne correspond pas à la petite finale.');
 if(c.podiumFormat==='INDIVIDUAL'){
  const semis=matches.filter(m=>m.round==='T4'&&m.isFinished);
  if(semis.length!==2||third.some(e=>!semis.some(m=>norm(m[`player${3-m.winner}`])===norm(e.name))))throw failure('Les bronzes ne correspondent pas aux demi-finales.');
 }
 return {gold:gold.id,silver:silver.id,bronze1:third[0].id,...(third[1]?{bronze2:third[1].id}:{}),finalConfirmed:true,...(bronze?{bronzeMatchConfirmed:true}:{})};
}
async function observe(c,existing,client,configured=null,loggedIn=false){
 const urls=[...new Set([...existing.map(m=>m.sourceUrl),configured?.sourceUrl].filter(Boolean))];
 if(urls.length!==1||!sourcePattern.test(urls[0]))throw failure('Un tableau FencingTimeLive officiel doit être relié à cette épreuve.',409);
 const sourceUrl=urls[0],eventId=sourcePattern.exec(sourceUrl)[1].toUpperCase(),config=configured||events[eventId];
 if(!config)throw failure('Cette épreuve doit être configurée pour le contrôle FencingTimeLive (identité et fuseau horaire).',409);
 if(c.name!==config.name||c.podiumFormat!==config.format||c.rosterSourceUrl!==`${ORIGIN}/events/competitors/${eventId}`)throw failure('La source ne correspond pas à cette épreuve.',409);
 podiumRules.roster(c);
 if(!loggedIn)await client.login();
 const $=verifyPage(await client.get(sourceUrl),config);
 const trees=await client.get(sourceUrl+'/trees');
 if(!Array.isArray(trees))throw failure('Liste des tableaux officiels indisponible.');
 const main=trees.filter(t=>t.treeNum===0),bronzes=trees.filter(t=>clean(t.name)==='Bronze Medal');
 if(main.length!==1||bronzes.length>1||(c.podiumFormat==='TEAM'&&bronzes.length!==1))throw failure('Tableau principal ou petite finale non identifiable.');
 let matches=[],rounds=[];
 for(const t of [...main,...(c.podiumFormat==='TEAM'?bronzes:[])]){
  if(!/^[a-f0-9]{32}$/i.test(t.guid)||!Number.isSafeInteger(t.numTables)||t.numTables<1||t.numTables>10)throw failure('Structure officielle inattendue.');
  const html=await client.get(`${sourceUrl}/trees/${t.guid}/tables/0/${t.numTables+1}`);
  const parsed=parseTable(html,{roster:c.podiumRoster,...config,maxScore:c.podiumFormat==='TEAM'?45:15,bronze:t!==main[0]});
  matches.push(...parsed.matches);rounds.push(...parsed.rounds);
 }
 validateManifest(rounds);
 if(new Set(matches.map(m=>m.sourceKey)).size!==matches.length)throw failure('Clés de rencontres dupliquées.');
 let officialPodium=null,resultsSourceUrl=null;const warnings=[];
 if(matches.some(m=>m.round==='T2'&&m.isFinished)&&(c.podiumFormat!=='TEAM'||matches.some(m=>m.round==='Bronze'&&m.isFinished))){
  try{
   const path=`/events/results/${eventId}`;
   if(!$('a').toArray().some(a=>$(a).attr('href')===path||$(a).attr('href')===ORIGIN+path))throw failure('Lien Results absent du tableau officiel.');
   resultsSourceUrl=ORIGIN+path;
   const resultPage=load(await client.get(resultsSourceUrl));
   const dataPath=resultPage('#resultList').attr('data-url');
   if(dataPath!==`/events/results/data/${eventId}`||!resultPage('h3').toArray().some(e=>clean(resultPage(e).text())==='Final Results'))throw failure('Classement final non publié.');
   officialPodium=podiumFromResults(await client.get(dataPath),c,matches);
  }catch(e){warnings.push(e.status?e.message:'Podium non vérifiable pour le moment.');}
 }
 return {sourceUrl,matches,rounds,officialPodium,resultsSourceUrl,warnings,checkedAt:new Date()};
}
function planMatches(existing,observation){
 const seen=new Set();
 const plan=observation.matches.map(m=>{
  let current=existing.find(e=>e.sourceKey===m.sourceKey);
  if(!current){const pair=existing.filter(e=>!e.sourceUrl&&!e.sourceKey&&pairKey(e)===pairKey(m));if(pair.length>1)throw failure('Plusieurs rencontres non sourcées correspondent à la même paire.',409);current=pair[0];}
  if(current){
   if(!samePair(current,m)||(current.round&&current.round!==m.round)||(current.sourceUrl&&current.sourceUrl!==observation.sourceUrl))throw failure(`Les adversaires ou la source du match #${current.id} ont changé. Vérification administrateur requise.`,409);
   if(current.isFinished&&!m.isFinished)throw failure(`Le résultat du match #${current.id} a été retiré de la source. Vérification requise.`,409);
   seen.add(current.id);
  }
  return {current,observed:m};
 });
 if(existing.some(m=>!seen.has(m.id)))throw failure('Une rencontre enregistrée ne figure plus dans le tableau officiel. Vérification requise.',409);
 return plan;
}
async function applyObservation(tx,c,observation,actorId){
 await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
 await tx.$queryRaw`SELECT id FROM "Match" WHERE "competitionId"=${c.id} ORDER BY id FOR UPDATE`;
 const current=await tx.competition.findUnique({where:{id:c.id}});
 for(const k of ['name','podiumFormat','podiumRoster','rosterSourceUrl'])if(JSON.stringify(current?.[k])!==JSON.stringify(c[k]))throw failure('La configuration de l’épreuve a changé pendant le contrôle.',409);
 const existing=await tx.match.findMany({where:{competitionId:c.id}}),plan=planMatches(existing,observation);
 const oldRounds=await tx.matchRound.findMany({where:{competitionId:c.id}});
 if(oldRounds.some(r=>!observation.rounds.some(n=>n.round===r.round)))throw failure('Un tour enregistré a disparu du tableau.',409);
 const summary={createdIds:[],created:0,results:0,corrections:0,pointsUpdated:0,podium:false,checked:plan.length,checkedAt:observation.checkedAt.toISOString(),warnings:observation.warnings};
 for(const r of observation.rounds)await tx.matchRound.upsert({where:{competitionId_round:{competitionId:c.id,round:r.round}},create:{competitionId:c.id,...r,sourceUrl:observation.sourceUrl,verifiedAt:observation.checkedAt},update:{...r,sourceUrl:observation.sourceUrl,verifiedAt:observation.checkedAt}});
 for(const {current:m,observed:o} of plan){
  const wasFinished=m?.isFinished;
  // Legacy scored finals may lack an explicit winner/type; filling those is not a score correction.
  const previousWinner=m?.winner??(Number.isInteger(m?.score1)&&Number.isInteger(m?.score2)&&m.score1!==m.score2?(m.score1>m.score2?1:2):null);
  const corrected=wasFinished&&(m.score1!==o.score1||m.score2!==o.score2||previousWinner!==o.winner||(m.resultType==='MEDICAL_WITHDRAWAL')!==(o.resultType==='MEDICAL_WITHDRAWAL'));
  const data={sourceUrl:observation.sourceUrl,sourceKey:o.sourceKey,round:o.round,sourceCheckedAt:observation.checkedAt,...(o.startsAt?{startsAt:o.startsAt}:{})};
  if(o.isFinished)Object.assign(data,{score1:o.score1,score2:o.score2,winner:o.winner,resultType:o.resultType,isFinished:true,isLocked:true,manualUnlock:false});
  const saved=m?await tx.match.update({where:{id:m.id},data}):await tx.match.create({data:{competitionId:c.id,player1:o.player1,player2:o.player2,...data}});
  if(!m){summary.created++;summary.createdIds.push(saved.id);}
  if(o.isFinished){
   if(!wasFinished)summary.results++;
   else if(corrected)summary.corrections++;
   for(const p of await tx.prediction.findMany({where:{matchId:saved.id}})){
    const pointsEarned=calculateMatchPoints(p.predictedScore1,p.predictedScore2,o.score1,o.score2,o.winner,o.resultType);
    if(p.pointsEarned!==pointsEarned){await tx.prediction.update({where:{id:p.id},data:{pointsEarned}});summary.pointsUpdated++;}
   }
  }
 }
 if(observation.officialPodium){
  // Validate every legacy selection before writing anything to the podium.
  const predictions=await tx.podiumPrediction.findMany({where:{competitionId:c.id}});
  let valid=true;try{predictions.forEach(p=>podiumRules.predictionIds(current,p));}catch(e){summary.warnings.push(e.message);valid=false;}
  if(valid){await tx.competition.update({where:{id:c.id},data:{officialPodium:observation.officialPodium,resultsSourceUrl:observation.resultsSourceUrl,resultsVerifiedAt:observation.checkedAt}});await podiumRules.resolvePodium(tx,c.id);summary.podium=true;}
 }

 return summary;
}
async function syncPools(db,c,config,actorId,client){
 const pools=await db.pool.findMany({where:{competitionId:c.id},include:{fencers:{orderBy:{position:'asc'}}},orderBy:{id:'asc'}});
 const urls=[...new Set([...pools.map(p=>p.sourceUrl),...(config.poolSources||[])].filter(Boolean))];
 const summary={checked:0,locks:0,finalized:0,changed:0,pointsUpdated:0,warnings:[]};
 for(const url of urls){
  try{
   const match=poolPattern.exec(url);if(!match||c.rosterSourceUrl?.toUpperCase()!==`https://www.fencingtimelive.com/events/competitors/${match[1]}`.toUpperCase())throw failure('Source de poules différente de la liste des engagés.');
   const $=verifyPage(await client.get(url),config),tables=$('table.poolTable').toArray();
   if(!tables.length)throw failure('Matrices de poules non encore publiées.');
   const poolNumbers=tables.map(t=>clean($(t).parent().find('.poolNum').text()));if(new Set(poolNumbers).size!==poolNumbers.length)throw failure('Numéros de poules ambigus.');
   for(const table of tables){
    try{
     const observed=parsePools($.html($(table).parent()))[0];
     for(const row of observed.rows)if((c.podiumRoster||[]).filter(e=>norm(e.name)===norm(row.name)).length!==1)throw failure('Composition de poule absente ou ambiguë dans les engagés.');
     let snapshot=pools.find(p=>p.sourceUrl===url&&p.sourcePoolNumber===observed.number);
     if(!snapshot){
      const candidates=pools.filter(p=>!p.sourceUrl&&!p.sourcePoolNumber&&p.name===`Poule ${observed.number}`&&p.fencers.length===observed.rows.length&&p.fencers.every((f,i)=>f.position===observed.rows[i].position&&norm(f.name)===norm(observed.rows[i].name)));
      if(candidates.length===1){const original=candidates[0];snapshot=await db.$transaction(async tx=>{
       await tx.$queryRaw`SELECT id FROM "Pool" WHERE id=${original.id} FOR UPDATE`;
       const current=await tx.pool.findUnique({where:{id:original.id},include:{fencers:{orderBy:{position:'asc'}}}});
       if(current.sourceUrl||current.sourcePoolNumber||JSON.stringify(current.fencers.map(f=>[f.id,f.name,f.position]))!==JSON.stringify(original.fencers.map(f=>[f.id,f.name,f.position])))throw failure('Composition de poule modifiée.',409);
       return tx.pool.update({where:{id:original.id},data:{sourceUrl:url,sourcePoolNumber:observed.number},include:{fencers:{orderBy:{position:'asc'}}}});
      });Object.assign(original,snapshot);}
     }
     if(!snapshot){
      // Do not duplicate an existing pool whose source has not been reconciled yet.
      if(pools.some(p=>p.fencers.some(f=>observed.rows.some(r=>norm(r.name)===norm(f.name)))))throw failure(`Poule ${observed.number} déjà présente sans correspondance de source certaine.`);
      snapshot=await db.$transaction(async tx=>{
       await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
       const current=await tx.competition.findUnique({where:{id:c.id}});
       if(JSON.stringify(current.podiumRoster)!==JSON.stringify(c.podiumRoster)||current.rosterSourceUrl!==c.rosterSourceUrl)throw failure('Liste des engagés modifiée.',409);
       const duplicate=await tx.pool.findFirst({where:{competitionId:c.id,sourceUrl:url,sourcePoolNumber:observed.number},include:{fencers:{orderBy:{position:'asc'}}}});if(duplicate)return duplicate;
       return tx.pool.create({data:{competitionId:c.id,name:`Poule ${observed.number}`,closesAt:new Date(config.date+'T00:00:00Z'),lockMode:'FIRST_RESULT',sourceUrl:url,sourcePoolNumber:observed.number,fencers:{create:observed.rows.map(r=>({name:r.name,position:r.position}))}},include:{fencers:{orderBy:{position:'asc'}}}});
      });pools.push(snapshot);
     }
     const result=await db.$transaction(tx=>applyPool(tx,snapshot,observed,new Date()),{timeout:15000});summary.checked++;
     for(const k of ['locks','finalized','changed','pointsUpdated'])summary[k]+=result[k];
     if(observed.ambiguous)summary.warnings.push(`Poule ${observed.number} : score réciproque manquant ; tireurs concernés verrouillés, bilan incomplet non inventé.`);
    }catch(e){summary.warnings.push(e.status?e.message:'Une poule n’a pas pu être importée. Réessayez.');}
   }
  }catch(e){summary.warnings.push(e.status?e.message:'Source de poules temporairement indisponible.');}
 }
 return summary;
}
async function syncCompetition(db,competitionId,actorId,client=createClient()){
 const c=await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184721)`;
  const latest=await tx.auditLog.findFirst({where:{action:START},orderBy:{createdAt:'desc'}});
  if(latest&&Date.now()-latest.createdAt.getTime()<COOLDOWN)throw Object.assign(failure('Un contrôle a déjà été lancé. Patientez deux minutes entre deux contrôles.',429),{retryAfter:Math.ceil((latest.createdAt.getTime()+COOLDOWN-Date.now())/1000)});
  const competition=await tx.competition.findUnique({where:{id:competitionId}});if(!competition)throw failure('Épreuve introuvable.',404);
  await tx.auditLog.create({data:{actorId,action:START,targetType:'Competition',targetId:competitionId}});return competition;
 });
 try{
  const existing=await db.match.findMany({where:{competitionId}}),configured=await configuration(db,competitionId);
  const source=[...existing.map(m=>m.sourceUrl),configured?.sourceUrl,configured?.poolSources?.[0],c.rosterSourceUrl].find(Boolean);
  const eventId=source?.match(/([a-f0-9]{32})/i)?.[1]?.toUpperCase(),config=configured||events[eventId];
  if(!config||c.name!==config.name||c.podiumFormat!==config.format)throw failure('Configurez la source et l’identité de cette épreuve dans Administration.',409);
  await client.login();
  const poolSummary=await syncPools(db,c,config,actorId,client);
  let summary={createdIds:[],created:0,results:0,corrections:0,pointsUpdated:0,podium:false,checked:0,checkedAt:new Date().toISOString(),warnings:[]};
  if(existing.some(m=>m.sourceUrl)||config.sourceUrl){
   try{const observation=await observe(c,existing,client,config,true);summary=await db.$transaction(tx=>applyObservation(tx,c,observation,actorId),{timeout:30000,maxWait:5000});}
   catch(e){if(!poolSummary.checked)throw e;summary.warnings.push(e.status?e.message:'Tableau non vérifiable pour le moment.');}
  }else summary.warnings.push('Tableau non encore relié. Vérifiez sa source dans la configuration après publication.');
  summary.pools=poolSummary;summary.pointsUpdated+=poolSummary.pointsUpdated;summary.warnings.push(...poolSummary.warnings);
  // Ranking history must never roll back a certain score or first-result lock.
  try{await db.$transaction(async tx=>{await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184723)`;await captureRankings(tx,c,actorId);},{timeout:30000});}catch{summary.warnings.push('Résultats enregistrés, historique du classement à réessayer au prochain contrôle.');}
  await db.auditLog.create({data:{actorId,action:DONE,targetType:'Competition',targetId:c.id,after:summary}});
  return summary;
 }catch(e){
  const safe=e.status?e:failure('Le contrôle n’a pas pu être terminé. Réessayez pour vérifier les résultats déjà enregistrés.',500);
  await db.auditLog.create({data:{actorId,action:FAILED,targetType:'Competition',targetId:competitionId,after:{error:safe.message}}}).catch(()=>{});throw safe;
 }
}
async function syncStatus(db,competitionId){
 const [last,latest]=await Promise.all([db.auditLog.findFirst({where:{targetType:'Competition',targetId:competitionId,action:{in:[DONE,FAILED]}},orderBy:{createdAt:'desc'}}),db.auditLog.findFirst({where:{action:START},orderBy:{createdAt:'desc'}})]);
 return {last:last?{at:last.createdAt,success:last.action===DONE,summary:last.after}:null,nextAllowedAt:latest?new Date(latest.createdAt.getTime()+COOLDOWN):null};
}
module.exports={syncCompetition,syncStatus,observe,planMatches,applyObservation,podiumFromResults,verifyPage};
