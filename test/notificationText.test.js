const {test}=require('node:test'),assert=require('node:assert/strict');
const {matchNotificationText,closingText}=require('../src/services/notificationText');
const now=new Date('2026-09-28T12:00:00Z'),m={startsAt:'2026-09-28T12:50:00Z'};
test('short event title, readable round, count and localized deadline',()=>{
 const p=matchNotificationText({name:"Senior Women's Saber"},'T2',[m],'Europe/Paris','AVAILABLE',now);
 assert.equal(p.title,"Senior Women's Saber");assert.match(p.body,/Finale · 1 match à pronostiquer · clôture à 14:50 UTC\+2/);
 assert.match(matchNotificationText({name:'Fleuret hommes'},'T32',Array(8).fill(m),'Europe/Istanbul','REMINDER',now).body,/T32 · 8 matchs à compléter · clôture à 15:50 UTC\+3/);
});
test('effective grace and admin reopening, never just planned start',()=>{
 assert.match(closingText([{startsAt:'2026-09-28T12:00:00Z',previousRoundCompletedAt:'2026-09-28T12:05:00Z'}],'Europe/Paris',now),/14:15/);
 assert.match(closingText([{...m,manualUnlockUntil:'2026-09-28T12:20:00Z'}],'Europe/Paris',now),/14:20/);
 for(const flag of ['awaitingPreviousRound','timingUnverified'])assert.equal(closingText([{...m,[flag]:true}],'Europe/Paris',now),'horaire de clôture à confirmer');
});
test('different or unknown deadlines are not described as a single round deadline',()=>{
 assert.match(closingText([m,{startsAt:'2026-09-28T13:00:00Z'}],'Europe/Paris',now),/^clôtures dès 14:50/);
 assert.equal(closingText([m,{}],'Europe/Paris',now),'horaire de clôture à confirmer');
 assert.match(closingText([{startsAt:'2026-09-29T12:50:00Z'}],'Europe/Paris',now),/le 29\/09$/);
});
