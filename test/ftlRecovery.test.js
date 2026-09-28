const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load } = require('cheerio');
const { parseTable } = require('../src/services/ftlParser');
const { planMatches, applyObservation, cancellable, drawSignature } = require('../src/services/ftlSync');
const { claim, finish, tick, windowDelay } = require('../src/services/ftlScheduler');
const { roundContext, matchClosed } = require('../src/lib/matchLock');
function parsed(file) {
  const html = fs.readFileSync(`${__dirname}/fixtures/${file}`, 'utf8'),
    $ = load(html);
  const names = [
    ...new Set(
      $('.tcln')
        .toArray()
        .map((el) => $(el).text().trim())
        .filter((n) => n && n !== '- BYE -'),
    ),
  ];
  return parseTable(html, { roster: names.map((name) => ({ name })), date: '2026-09-27' });
}
test('real reseeded men draw isolates five changed pairs and still imports the other 17', () => {
  const old = parsed('ftl-team.html').matches.map((m, i) => ({ ...m, id: 136 + i, sourceUrl: 'source' }));
  const observation = { ...parsed('ftl-team-reseeded.html'), sourceUrl: 'source' };
  assert.equal(observation.matches.length, 22);
  const plan = planMatches(old, observation, { allowPartial: true });
  assert.deepEqual(
    plan.conflicts.map((c) => c.id),
    [136, 138, 139, 142, 143],
  );
  assert.equal(plan.length, 17);
  assert.ok(
    plan.conflicts.every((c) =>
      cancellable(
        old.find((m) => m.id === c.id),
        observation,
      ),
    ),
  );
  assert.equal(plan.find((p) => p.current?.id === 137).observed.score2, 45);
  assert.notEqual(drawSignature(observation), drawSignature({ ...observation, matches: old }));
});
test('confirmed cancellation keeps old IDs, pairs and prediction scores; rerun is idempotent', async () => {
  const c = { id: 1, name: 'Event' },
    matches = [
      {
        id: 7,
        competitionId: 1,
        player1: 'A',
        player2: 'B',
        round: 'T2',
        sourceKey: 'Finals:1',
        sourceUrl: 'source',
        isFinished: false,
      },
    ];
  const predictions = [{ id: 4, matchId: 7, predictedScore1: 45, predictedScore2: 30, pointsEarned: 1 }];
  const tx = {
    $queryRaw: async () => [],
    competition: { findUnique: async () => c },
    matchRound: { findMany: async () => [], upsert: async () => {} },
    match: {
      findMany: async () => matches,
      update: async ({ where, data }) =>
        Object.assign(
          matches.find((m) => m.id === where.id),
          data,
        ),
      create: async ({ data }) => {
        const m = { id: 8, ...data };
        matches.push(m);
        return m;
      },
    },
    prediction: {
      updateMany: async ({ where, data }) => {
        const rows = predictions.filter((p) => Object.entries(where).every(([k, v]) => p[k] === v));
        rows.forEach((p) => Object.assign(p, data));
        return { count: rows.length };
      },
      findMany: async ({ where }) => predictions.filter((p) => p.matchId === where.matchId),
    },
    auditLog: { create: async () => {} },
    pushEvent: { create: async () => {} },
  };
  const o = {
    sourceUrl: 'source',
    drawConfirmed: true,
    rounds: [],
    warnings: [],
    checkedAt: new Date(),
    matches: [
      {
        sourceKey: 'Finals:1',
        round: 'T2',
        player1: 'C',
        player2: 'B',
        isFinished: true,
        winner: 2,
        score1: 20,
        score2: 45,
        resultType: 'NORMAL',
      },
    ],
  };
  const result = await applyObservation(tx, c, o, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.created, 1);
  assert.equal(matches[0].player1, 'A');
  assert.equal(matches[0].resultType, 'CANCELLED');
  assert.deepEqual(predictions, [{ id: 4, matchId: 7, predictedScore1: 45, predictedScore2: 30, pointsEarned: 0, bonusPoints: 0 }]);
  const again = await applyObservation(tx, c, o, 1);
  assert.equal(again.cancelled, 0);
  assert.equal(again.created, 0);
  assert.equal(matches.length, 2);
});
test('published matches and moved pairs are never automatically cancelled', () => {
  const m = { sourceUrl: 's', isFinished: false, round: 'T4', player1: 'A', player2: 'B' };
  assert.equal(cancellable({ ...m, isFinished: true }, { sourceUrl: 's', matches: [] }), false);
  assert.equal(cancellable(m, { sourceUrl: 's', matches: [{ ...m, player1: 'B', player2: 'A' }] }), false);
});
test('cancellation is excluded from previous round completion and cannot be unlocked', () => {
  const matches = [
    { id: 1, competitionId: 1, round: 'T4', isFinished: true, resultRegisteredAt: new Date(1000) },
    { id: 2, competitionId: 1, round: 'T4', isFinished: true, resultRegisteredAt: new Date(2000) },
    {
      id: 3,
      competitionId: 1,
      round: 'T4',
      resultType: 'CANCELLED',
      isFinished: true,
      resultRegisteredAt: new Date(3000),
    },
    { id: 4, competitionId: 1, round: 'T2' },
  ];
  const result = roundContext(matches, [
    { competitionId: 1, round: 'T4', expectedMatchCount: 2 },
    { competitionId: 1, round: 'T2', previousRound: 'T4' },
  ]);
  assert.equal(result[3].previousRoundCompletedAt, new Date(2000).toISOString());
  assert.equal(matchClosed({ syncIssue: 'Changed', manualUnlockUntil: new Date(Date.now() + 600000) }), true);
});
test('claims are per event, reject active leases, and recover an expired lease', async () => {
  const states = new Map();
  const db = {
    tournament: { findUnique: async () => ({}) },
    $queryRaw: async () => [],
    competition: { findUnique: async ({ where }) => ({ id: where.id }) },
    ftlSyncState: {
      upsert: async ({ where }) => states.get(where.competitionId) || {},
      update: async ({ where, data }) => states.set(where.competitionId, { ...data }),
    },
  };
  db.$transaction = (fn) => fn(db);
  const now = new Date();
  const one = await claim(db, 1, { now });
  assert.ok(one.token);
  assert.ok(await claim(db, 2, { now }));
  await assert.rejects(claim(db, 1, { now }), (e) => e.status === 409);
  assert.ok(await claim(db, 1, { now: new Date(now.getTime() + 180001) }));
});
test('retry backoff, complete stop and stale token guard', async () => {
  let state = { leaseToken: 'a', failures: 2 };
  const db = {
    ftlSyncState: { findUnique: async () => state, updateMany: async ({ data }) => Object.assign(state, data) },
  };
  const now = new Date(1000000);
  await finish(db, 1, 'b', null, 'err', now);
  assert.equal(state.leaseToken, 'a');
  await finish(db, 1, 'a', null, 'err', now);
  assert.equal(state.status, 'ERROR');
  assert.equal(+state.nextAutomaticAt, +now + 480000);
  state.leaseToken = 'c';
  await finish(db, 1, 'c', { podium: true, warnings: [], conflicts: [] }, null, now);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.nextAutomaticAt, null);
});
test('automatic scan visits both events despite one error, with no AI or browser session', async () => {
  const ids = ['F11BB8AC692C4073BA38A7592EC7309E', '647A20DB3116411181393C8F779CD2A4'];
  const seen = [];
  const db = {
    competition: {
      findMany: async () =>
        ids.map((id, i) => ({
          id: i + 5,
          rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${id}`,
        })),
    },
    auditLog: { findFirst: async () => null },
    ftlSyncState: { findMany: async () => [] },
  };
  await tick(db, {
    archive: async () => [],
    now: new Date('2026-09-28'),
    sync: async (db, id, actor, client, options) => {
      seen.push(id);
      assert.equal(actor, 0);
      assert.equal(options.automatic, true);
      if (id === 5) throw Error('upstream');
      return { created: 2 };
    },
  });
  assert.deepEqual(seen, [5, 6]);
  assert.equal(windowDelay({ date: '2026-10-10' }, Date.parse('2026-09-28')), 86400000);
});
