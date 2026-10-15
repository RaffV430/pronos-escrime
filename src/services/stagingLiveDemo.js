// Exclusif à la branche de maquette : aucun accès FTL, mail ou push.
const express = require('express');
const auth = require('../middleware/auth');
const GUID = 'F1000000000000000000000000000015';
const SOURCE = `https://pronos-escrime-refonte-test.onrender.com/tournaments/eventSchedule/${GUID}`;
let fixture = null,
  secondStarted = false,
  step = 0;
function enabled() {
  let host = '';
  try {
    host = new URL(process.env.DATABASE_URL).hostname;
  } catch {
    return false;
  }
  return (
    process.env.RENDER_SERVICE_ID === 'srv-db7911tg1s2s739j99og' &&
    /^ep-tiny-mouse-b1lipgr7(-pooler)?\./.test(host) &&
    process.env.FTL_AUTO_SYNC === 'false' &&
    process.env.FTL_LIVE_SCORES === 'false' &&
    process.env.CALENDAR_WATCH === 'false' &&
    !process.env.RESEND_API_KEY &&
    !process.env.VAPID_PRIVATE_KEY
  );
}
async function seed(db) {
  const t = await db.tournament.upsert({
    where: { ftlSourceUrl: SOURCE },
    create: { name: '[SIMULATION] Nouveautés Direct · maquette', ftlSourceUrl: SOURCE },
    update: {},
  });
  let c = await db.competition.findFirst({ where: { tournamentId: t.id, name: 'Fleuret hommes · TEST LIVE' } });
  if (!c) c = await db.competition.create({ data: { tournamentId: t.id, name: 'Fleuret hommes · TEST LIVE' } });
  const names = [
    ['TEST ALPHA', 'TEST BETA'],
    ['TEST GAMMA', 'TEST DELTA'],
    ['TEST ECHO', 'TEST FOXTROT'],
  ];
  const matches = [];
  for (let i = 0; i < 3; i++) {
    let m = await db.match.findFirst({ where: { competitionId: c.id, sourceKey: `staging-live:${i}` } });
    if (!m)
      m = await db.match.create({
        data: {
          competitionId: c.id,
          sourceKey: `staging-live:${i}`,
          round: i === 2 ? 'T128' : 'T64',
          player1: names[i][0],
          player2: names[i][1],
          strip: String(i + 1),
          startsAt: new Date(Date.now() + 7 * 86400000),
          ...(i === 2 ? { isFinished: true, score1: 15, score2: 8, winner: 1, resultType: 'NORMAL' } : {}),
        },
      });
    matches.push(m);
  }
  for (const round of ['T64', 'T128'])
    await db.matchRound.upsert({
      where: { competitionId_round: { competitionId: c.id, round } },
      create: {
        competitionId: c.id,
        round,
        previousRound: null,
        expectedMatchCount: round === 'T64' ? 2 : 1,
        sourceUrl: SOURCE,
        verifiedAt: new Date(),
      },
      update: {},
    });
  const u = await db.user.findUnique({ where: { name: 'ValidationRefonte' } });
  if (u)
    for (const m of matches.slice(0, 2))
      await db.prediction.upsert({
        where: { userId_matchId: { userId: u.id, matchId: m.id } },
        create: { userId: u.id, matchId: m.id, predictedScore1: 15, predictedScore2: 8 },
        update: {},
      });
  fixture = { tournamentId: t.id, competitionId: c.id, matchIds: matches.map((m) => m.id), matches };
  secondStarted = Boolean(matches[1].liveDetectedAt);
}
function frame(match, l, r, reverse = false) {
  return {
    TournGuid: GUID,
    StripNum: match.strip,
    Clock: 137,
    PeriodNum: 1,
    Left: { Name: reverse ? match.player2 : match.player1, Score: l, ScoreLamp: step % 3 === 0 },
    Right: {
      Name: reverse ? match.player1 : match.player2,
      Score: r,
      ScoreLamp: step % 3 === 1,
      WhiteLamp: step % 3 === 2,
    },
  };
}
async function start(db) {
  if (!enabled()) return () => {};
  await seed(db);
  const F = require('./ftlLiveScores'),
    guids = new Set([GUID]);
  const h = fixture.matches[2];
  let s = F.record(frame(h, 0, 0), Date.now(), guids);
  s = F.record(frame(h, 8, 15), Date.now() + 1, guids);
  F.matchLive([{ ...h, isFinished: false }], [s]);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      step++;
      F.record(
        frame(fixture.matches[0], Math.min(12, Math.floor(step / 2)), Math.min(13, Math.floor((step + 1) / 2)), true),
        Date.now(),
        guids,
      );
      if (secondStarted)
        F.record(
          frame(fixture.matches[1], Math.min(12, Math.floor(step / 2)), Math.min(13, Math.floor((step + 1) / 2))),
          Date.now(),
          guids,
        );
      await F.persistLiveLocks(db, fixture.competitionId);
    } catch (e) {
      console.error('Simulation maquette:', e.message);
    } finally {
      busy = false;
    }
  };
  await tick();
  const timer = setInterval(tick, 2500);
  timer.unref();
  console.log('Simulation Direct active : uniquement la base preview/refonte/maquette.');
  return () => clearInterval(timer);
}
function router() {
  const r = express.Router();
  r.use((req, res, next) => (enabled() ? next() : res.sendStatus(404)));
  r.get('/calendar-checks', async (req, res) => {
    try {
      res.json(await require('./stagingCalendarChecks')());
    } catch {
      res.status(500).json({ error: 'Scénario de maquette indisponible.' });
    }
  });
  r.use(auth);
  r.get('/', (req, res) => res.json(fixture ? { ...fixture, matches: undefined, secondStarted } : {}));
  r.post('/start-second', (req, res) => {
    secondStarted = true;
    res.json({ ok: true });
  });
  return r;
}
module.exports = { enabled, start, router };
