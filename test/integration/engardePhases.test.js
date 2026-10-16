const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('engarde_phases');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('engarde_phases');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL Engarde : J1 puis principal tardif, deux T64, IDs et pronostic/points préservés après réimport',
  { skip },
  async () => {
    const E = require('../../src/services/engardeParser');
    const { observeTableau } = require('../../src/services/engardeSync');
    const { applyObservation } = require('../../src/services/ftlSync');
    const fixture = (n) => fs.readFileSync(`${__dirname}/../fixtures/engarde/${n}`, 'utf8');
    const prelim = fixture('doha-prelim-anonymous.html'),
      main = fixture('doha-main-anonymous.html');
    const names = [
      ...new Set(
        [prelim, main].flatMap((html) => E.parseTableaus([html]).matches.flatMap((m) => [m.player1, m.player2])),
      ),
    ];
    const user = await db.user.create({
      data: { email: 'engarde-phases@example.invalid', name: 'TEST', password: 'test' },
    });
    const t = await db.tournament.create({ data: { name: 'TEST PHASES ENGARDE' } });
    const c = await db.competition.create({
      data: {
        name: 'TEST SENIOR',
        tournamentId: t.id,
        podiumFormat: 'INDIVIDUAL',
        podiumRoster: names.map((name, i) => ({ id: String(i + 1), name })),
      },
    });
    const base = 'https://engarde-service.com/competition/test/gp/senior';
    const config = { eventSourceUrl: base, preliminaryUntil: 'T64', date: '2026-10-16', timezone: 'Europe/Paris' };
    const pages = {
      tableaus: [base + '/tableauPreliminaire.htm'],
      preliminary: [base + '/tableauPreliminaire.htm'],
      final: null,
    };
    const client = { get: async (u) => (u.includes('Preliminaire') ? prelim : main) };
    const j1 = await observeTableau(c, config, pages, client);
    await db.$transaction((tx) => applyObservation(tx, c, j1, user.id), { timeout: 30000 });
    const old = await db.match.findFirst({ where: { competitionId: c.id, round: 'J1:T64', isFinished: true } });
    const p = await db.prediction.create({
      data: {
        userId: user.id,
        matchId: old.id,
        predictedScore1: old.score1,
        predictedScore2: old.score2,
        pointsEarned: 4,
      },
    });
    const ids = (await db.match.findMany({ where: { competitionId: c.id }, select: { id: true } })).map((m) => m.id);
    const both = await observeTableau(
      c,
      config,
      { ...pages, tableaus: [...pages.tableaus, base + '/tableau64.htm'] },
      client,
    );
    await db.$transaction((tx) => applyObservation(tx, c, both, user.id), { timeout: 30000 });
    const first = await db.match.findMany({ where: { competitionId: c.id }, orderBy: { id: 'asc' } });
    assert.equal(first.filter((m) => m.round === 'J1:T64').length, 32);
    assert.equal(first.filter((m) => m.round === 'T64').length, 32);
    assert.ok(ids.every((id) => first.some((m) => m.id === id)));
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
    const untouched = await db.match.findUnique({ where: { id: old.id } });
    assert.equal(untouched.resultRegisteredAt.toISOString(), old.resultRegisteredAt.toISOString());
    await db.$transaction((tx) => applyObservation(tx, c, both, user.id), { timeout: 30000 });
    assert.deepEqual(
      (await db.match.findMany({ where: { competitionId: c.id }, orderBy: { id: 'asc' }, select: { id: true } })).map(
        (m) => m.id,
      ),
      first.map((m) => m.id),
    );
    assert.deepEqual(await db.prediction.findUnique({ where: { id: p.id } }), p);
    assert.equal((await db.competition.findUnique({ where: { id: c.id } })).officialPodium, null);
  },
);
