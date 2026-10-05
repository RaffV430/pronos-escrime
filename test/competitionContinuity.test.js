const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { load } = require('cheerio');
const { parseTable } = require('../src/services/ftlParser');
const E = require('../src/services/engardeParser');
const { roundContext, closesAt } = require('../src/lib/matchLock');
const { applyObservation } = require('../src/services/ftlSync');
const { matchRow } = require('../src/services/season');
const fixture = (n) => fs.readFileSync(`${__dirname}/fixtures/${n}`, 'utf8');
test('one unreadable FTL score isolates points, keeps confirmed advancement and other pairs', () => {
  const html = fixture('ftl-individual-partial.html');
  const $ = load(html);
  const roster = [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
  const options = { date: '2026-09-26', roster, maxScore: 15, requireComplete: false };
  const original = parseTable(html, options);
  const corrupt = html.replace('15 - 10', '16 - 10');
  assert.notEqual(corrupt, html);
  assert.throws(() => parseTable(corrupt, options), /incohérent/);
  const parsed = parseTable(corrupt, { ...options, allowPartial: true });
  assert.equal(parsed.matches.length, original.matches.length);
  const affected = parsed.matches.find((m) => m.pointsPending);
  assert.equal(affected.winner, 1);
  assert.equal(affected.score1, null);
  assert.equal(affected.isFinished, false);
  assert.equal(parsed.issues.length, 1);
  assert.ok(parsed.matches.some((m) => m.isFinished));
  const unknown = parseTable(html, { ...options, roster: roster.slice(1), allowPartial: true });
  assert.ok(unknown.issues.length);
  assert.ok(unknown.matches.length > 0);
});
test('one unreadable Engarde score leaves other official results available', () => {
  const html = fixture('engarde/equipes-fheq-tableau16.html');
  const original = E.parseTableaus([html]);
  const corrupt = html.replace('45/44', '45/46');
  assert.notEqual(corrupt, html);
  const parsed = E.parseTableaus([corrupt], { allowPartial: true });
  assert.equal(parsed.matches.length, original.matches.length);
  assert.ok(parsed.matches.some((m) => m.pointsPending && m.winner));
  assert.ok(parsed.matches.some((m) => m.isFinished));
});
test('common grace waits for last sporting advancement, not later point validation', () => {
  const stamp = '2026-10-05T10:00:00Z';
  const rounds = [
    { competitionId: 1, round: 'T4', expectedMatchCount: 2 },
    { competitionId: 1, round: 'T2', previousRound: 'T4', expectedMatchCount: 1 },
  ];
  const prior = [
    { competitionId: 1, round: 'T4', isFinished: true, resultRegisteredAt: '2026-10-05T09:55:00Z' },
    { competitionId: 1, round: 'T4', pointsPending: true, syncIssue: 'score', progressionConfirmedAt: stamp },
  ];
  const next = { competitionId: 1, round: 'T2' };
  assert.equal(closesAt(roundContext([...prior, next], rounds).at(-1)), '2026-10-05T10:10:00.000Z');
  assert.equal(
    roundContext([{ ...prior[0] }, { ...prior[1], progressionConfirmedAt: null }, next], rounds).at(-1)
      .awaitingPreviousRound,
    true,
  );
  assert.equal(
    closesAt(
      roundContext(
        [
          prior[0],
          { ...prior[1], isFinished: true, pointsPending: false, resultRegisteredAt: '2026-10-05T10:30:00Z' },
          next,
        ],
        rounds,
      ).at(-1),
    ),
    '2026-10-05T10:10:00.000Z',
  );
});
test('pending import preserves prediction IDs and picks, removes only affected points, keeps freshness; resolution is idempotent', async () => {
  const c = { id: 1, name: 'Event', podiumRoster: [], rosterSourceUrl: 'roster' };
  const m = {
    id: 7,
    competitionId: 1,
    sourceKey: 'Finals:1',
    sourceUrl: 'source',
    round: 'T2',
    player1: 'A',
    player2: 'B',
    isFinished: true,
    isLocked: true,
    score1: 15,
    score2: 8,
    winner: 1,
    resultRegisteredAt: new Date('2026-10-05T10:00:00Z'),
    sourceCheckedAt: new Date('2026-10-05T10:00:00Z'),
  };
  const p = { id: 9, matchId: 7, predictedScore1: 15, predictedScore2: 8, pointsEarned: 4, bonusPoints: 0 };
  const db = {
    $queryRaw: async () => [],
    competition: { findUnique: async () => c },
    match: { findMany: async () => [m], update: async ({ data }) => Object.assign(m, data) },
    matchRound: { findMany: async () => [], upsert: async () => {} },
    prediction: {
      findMany: async () => [p],
      updateMany: async ({ where, data }) => {
        if (!Object.entries(where).every(([k, v]) => p[k] === v)) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      },
    },
    auditLog: { create: async () => {} },
  };
  const raw = {
    ...m,
    isFinished: false,
    pointsPending: true,
    syncIssue: 'score illisible',
    score1: null,
    score2: null,
  };
  const obs = {
    sourceUrl: 'source',
    checkedAt: new Date('2026-10-05T11:00:00Z'),
    rounds: [],
    warnings: [],
    matches: [raw],
  };
  await applyObservation(db, c, obs, 1);
  assert.equal(p.pointsEarned, 0);
  assert.equal(m.score1, 15);
  assert.equal(m.sourceCheckedAt.toISOString(), '2026-10-05T10:00:00.000Z');
  assert.deepEqual([p.id, p.predictedScore1, p.predictedScore2], [9, 15, 8]);
  assert.equal(matchRow({ ...p, match: m }).points, null);
  assert.equal(m.progressionConfirmedAt.toISOString(), '2026-10-05T10:00:00.000Z');
  m.manualResultConfirmed = true;
  m.pointsPending = false;
  await applyObservation(db, c, obs, 1);
  assert.equal(p.pointsEarned, 4);
  assert.equal(m.pointsPending, false);
  obs.matches = [
    { ...raw, isFinished: true, pointsPending: false, syncIssue: null, score1: 15, score2: 8, resultType: 'NORMAL' },
  ];
  await applyObservation(db, c, obs, 1);
  assert.equal(m.manualResultConfirmed, false);
  assert.equal(p.pointsEarned, 4);
  const again = await applyObservation(db, c, obs, 1);
  assert.equal(again.pointsUpdated, 0);
});
test('adversaires modifiés sur la source : la validation admin fait foi tant que l’écart ne change pas', async () => {
  const c = { id: 1, name: 'Event', podiumRoster: [], rosterSourceUrl: 'roster' };
  const m = {
    id: 7,
    competitionId: 1,
    sourceKey: 'T16:1',
    sourceUrl: 'source',
    round: 'T16',
    player1: 'DUPONT',
    player2: 'MARTIN',
    isFinished: true,
    isLocked: true,
    score1: 15,
    score2: 10,
    winner: 1,
    resultType: 'NORMAL',
    resultRegisteredAt: new Date('2026-10-05T10:00:00Z'),
  };
  const p = { id: 9, matchId: 7, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4, bonusPoints: 0 };
  const audit = [];
  const db = {
    $queryRaw: async () => [],
    competition: { findUnique: async () => c },
    match: { findMany: async () => [{ ...m }], update: async ({ data }) => Object.assign(m, data) },
    matchRound: { findMany: async () => [], upsert: async () => {} },
    prediction: {
      findMany: async () => [{ ...p }],
      updateMany: async ({ where, data }) => {
        if (!Object.entries(where).every(([k, v]) => p[k] === v)) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      },
    },
    auditLog: {
      create: async ({ data }) => audit.push({ id: audit.length + 1, ...data }),
      findFirst: async ({ where }) =>
        audit.filter((a) => a.targetId === where.targetId && where.action.in.includes(a.action)).at(-1) || null,
    },
  };
  const observe = (player2) => ({
    sourceUrl: 'source',
    checkedAt: new Date('2026-10-05T11:00:00Z'),
    rounds: [],
    warnings: [],
    matches: [{ ...m, player2, isFinished: true, score1: 15, score2: 10 }],
  });
  // 1. La source montre MARTINEZ au lieu de MARTIN : vérification, points en attente.
  let s = await applyObservation(db, c, observe('MARTINEZ'), 1);
  assert.ok(m.syncIssue);
  assert.equal(m.pointsPending, true);
  assert.equal(p.pointsEarned, 0);
  assert.equal(s.warnings.length, 1);
  // 2. L'administrateur valide le résultat (route admin).
  Object.assign(m, { syncIssue: null, pointsPending: false, manualResultConfirmed: true });
  p.pointsEarned = 4;
  audit.push({ id: audit.length + 1, action: 'Correction du résultat officiel', targetType: 'Match', targetId: 7 });
  // 3. Contrôles suivants, même écart : validation conservée, plus de signalement.
  for (let i = 0; i < 3; i++) {
    s = await applyObservation(db, c, observe('MARTINEZ'), 1);
    assert.equal(m.syncIssue, null);
    assert.equal(m.pointsPending, false);
    assert.equal(p.pointsEarned, 4);
    assert.deepEqual(s.warnings, []);
  }
  assert.equal(audit.filter((a) => a.action === 'Écart source conservé après validation').length, 1);
  // 4. La source change encore (autre adversaire) : nouvelle vérification.
  s = await applyObservation(db, c, observe('BERNARD'), 1);
  assert.ok(m.syncIssue);
  assert.equal(m.pointsPending, true);
  assert.equal(m.manualResultConfirmed, false);
  assert.equal(p.pointsEarned, 0);
});
test('match en attente : une seule ligne d’avertissement, plus rien une fois validé par l’administration', async () => {
  const c = { id: 1, name: 'Event', podiumRoster: [], rosterSourceUrl: 'roster' };
  const m = {
    id: 7,
    competitionId: 1,
    sourceKey: 'T32:4',
    sourceUrl: 'source',
    round: 'T32',
    player1: 'A',
    player2: 'B',
    isFinished: false,
    isLocked: true,
  };
  const db = {
    $queryRaw: async () => [],
    competition: { findUnique: async () => c },
    match: { findMany: async () => [{ ...m }], update: async ({ data }) => Object.assign(m, data) },
    matchRound: { findMany: async () => [], upsert: async () => {} },
    prediction: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    auditLog: { create: async () => {} },
  };
  const message = 'T32 · match 4 : Score final incohérent.';
  const obs = {
    sourceUrl: 'source',
    checkedAt: new Date('2026-10-05T11:00:00Z'),
    rounds: [],
    issues: [{ sourceKey: 'T32:4', round: 'T32', message }, { message: 'Page de tableau 2 : illisible.' }],
    warnings: [message, 'Page de tableau 2 : illisible.'],
    matches: [{ ...m, winner: 1, pointsPending: true, syncIssue: message }],
  };
  let s = await applyObservation(db, c, obs, 1);
  assert.deepEqual([...s.warnings].sort(), [message, 'Page de tableau 2 : illisible.'].sort());
  assert.equal(s.warnings.filter((w) => w === message).length, 1);
  // Validation par l'administration (même vainqueur que la source) : la ligne du match disparaît.
  Object.assign(m, {
    manualResultConfirmed: true,
    pointsPending: false,
    syncIssue: null,
    isFinished: true,
    score1: 15,
    score2: 9,
    winner: 1,
    resultType: 'NORMAL',
  });
  s = await applyObservation(db, c, obs, 1);
  assert.deepEqual(s.warnings, ['Page de tableau 2 : illisible.']);
});
