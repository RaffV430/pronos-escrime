const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateMatchPoints, predictionText } = require('../src/services/matchPoints');
const { funTags, scoreGap } = require('../src/services/funFilters');
const { summarizeCrowd } = require('../src/services/crowd');
const { validatePrediction, poolPoints, comparison, poolPredictionText } = require('../src/services/poolRules');
const { checkSafety, statements } = require('../src/services/migrations');

test('a winner-only prediction earns the winner point but never the exact-score bonus', () => {
  assert.equal(calculateMatchPoints(1, 0, 15, 12, 1, 'NORMAL', true), 1);
  assert.equal(calculateMatchPoints(1, 0, 1, 0, 1, 'NORMAL', true), 1);
  assert.equal(calculateMatchPoints(1, 0, 1, 0, 1, 'NORMAL', false), 4);
  assert.equal(calculateMatchPoints(0, 1, 15, 12, 1, 'NORMAL', true), 0);
  assert.equal(calculateMatchPoints(0, 1, null, null, 2, 'MEDICAL_WITHDRAWAL', true), 1);
  const m = { player1: 'MARTIN Léa', player2: 'DURAND Chloé' };
  assert.equal(
    predictionText({ predictedScore1: 0, predictedScore2: 1, winnerOnly: true }, m),
    'Vainqueur : DURAND Chloé',
  );
  assert.equal(predictionText({ predictedScore1: 15, predictedScore2: 9 }, m), '15 – 9');
});

test('winner-only predictions keep the upset and one-touch tags, without score gaps', () => {
  const m = { isFinished: true, score1: 15, score2: 14, seed1: 20, seed2: 3, winner: 1 };
  const p = { predictedScore1: 1, predictedScore2: 0, winnerOnly: true };
  assert.deepEqual(funTags(p, m), ['poker', 'wire']);
  assert.deepEqual(funTags({ ...p, predictedScore1: 0, predictedScore2: 1 }, m), []);
  assert.equal(scoreGap(p, m), null);
});

test('crowd trends count winner-only picks but not as a predicted score', () => {
  const out = summarizeCrowd([
    { matchId: 1, predictedScore1: 1, predictedScore2: 0, winnerOnly: true, _count: { _all: 5 } },
    { matchId: 1, predictedScore1: 15, predictedScore2: 10, winnerOnly: false, _count: { _all: 2 } },
    { matchId: 1, predictedScore1: 8, predictedScore2: 15, winnerOnly: false, _count: { _all: 3 } },
  ]);
  assert.equal(out[1].total, 10);
  assert.equal(out[1].player1Pct, 70);
  assert.deepEqual(out[1].topScore, { score1: 8, score2: 15, count: 3 });
});

test('a pool prediction may give the wins only, which scores the wins only', () => {
  assert.deepEqual(validatePrediction({ wins: 3, losses: 2, indicator: null }, 6, { optionalIndicator: true }), {
    wins: 3,
    losses: 2,
    indicator: null,
  });
  assert.throws(() => validatePrediction({ wins: 3, losses: 2, indicator: null }, 6), /entiers/);
  assert.throws(() => validatePrediction({ wins: 3, losses: 1 }, 6, { optionalIndicator: true }), /égales à 5/);
  const result = { wins: 3, losses: 2, indicator: 4 };
  assert.deepEqual(poolPoints({ wins: 3, indicator: null }, result), { winsPoints: 3, indicatorPoints: 0, total: 3 });
  assert.equal(poolPoints({ wins: 3, indicator: 4 }, result).total, 8);
  // Match annulé : l'indice absent reste absent.
  assert.deepEqual(poolPoints({ wins: 3, indicator: null }, { wins: 3, losses: 1, indicator: 2 }, 6).adjusted, {
    wins: 3,
    indicator: null,
    annulled: 1,
  });
  const c = comparison({ wins: 3, losses: 2, indicator: null }, result, true, 6);
  assert.equal(c.indicatorCorrect, false);
  assert.equal(c.indicatorDifference, null);
  assert.equal(poolPredictionText({ wins: 3, indicator: null }), '3 V');
  assert.equal(poolPredictionText({ wins: 3, indicator: -2 }), '3 V · indice -2');
});

test('making a column optional is not treated as destructive', () => {
  const file = '202610112300_quick_predictions.sql';
  const sql = fs.readFileSync(path.join(__dirname, '../prisma/auto', file), 'utf8');
  assert.doesNotThrow(() => checkSafety(file, statements(sql), { PoolPrediction: ['indicator'] }));
  assert.throws(
    () => checkSafety('202610112301_x.sql', ['ALTER TABLE "Pool" DROP COLUMN "name"'], { Pool: ['name'] }),
    /destructive/,
  );
});

test('an official withdrawal sets the fencer status automatically and zeroes predictions on them', async () => {
  const { applyPool, officialStatus, recordStatuses } = require('../src/services/ftlPools');
  assert.equal(officialStatus('Medical Withdrawal'), 'MEDICAL');
  assert.equal(officialStatus('Failed to Appear'), 'ABSENT');
  assert.equal(officialStatus('EXCLUSION'), 'EXCLUDED');
  assert.equal(officialStatus('ABANDON'), 'MEDICAL');
  assert.equal(officialStatus('Something else'), null);
  const fencers = [
    { id: 1, name: 'A', position: 1 },
    { id: 2, name: 'B', position: 2 },
    { id: 3, name: 'C', position: 3, status: 'ABSENT' },
  ];
  const pool = {
    id: 9,
    competitionId: 1,
    sourceUrl: 'u',
    sourcePoolNumber: 4,
    lockMode: 'FIRST_RESULT',
    isLocked: false,
    isFinal: false,
    name: 'Poule 4',
    fencers,
  };
  const updates = [];
  let zeroed = null;
  const tx = {
    $queryRaw: async () => [],
    pool: { findUnique: async () => pool, update: async () => pool },
    poolFencer: { updateMany: async ({ where, data }) => (updates.push([where.id, data]), { count: 1 }) },
    poolPrediction: {
      findMany: async () => [],
      updateMany: async ({ where }) => ((zeroed = where.fencerId.in), { count: 2 }),
    },
  };
  const observed = {
    complete: false,
    rows: [
      { name: 'A', position: 1, hasResult: true, wins: 1, losses: 0, indicator: 3 },
      { name: 'B', position: 2, absent: true, status: 'Medical Withdrawal', wins: null, losses: null, indicator: null },
      // Statut déjà posé (par l'administration) : jamais remplacé.
      { name: 'C', position: 3, absent: true, status: 'Medical Withdrawal', wins: null, losses: null, indicator: null },
    ],
  };
  const out = await applyPool(tx, pool, observed, new Date());
  assert.equal(updates.find(([id]) => id === 2)[1].status, 'MEDICAL');
  assert.equal(updates.find(([id]) => id === 3)?.[1].status, undefined);
  assert.deepEqual(zeroed.sort(), [2, 3]);
  assert.deepEqual(out.statuses, [{ id: 2, name: 'B', status: 'MEDICAL', pool: 'Poule 4' }]);
  const logs = [];
  const summary = {};
  await recordStatuses({ auditLog: { create: async (q) => logs.push(q.data) } }, { id: 1 }, out.statuses, 0, summary);
  assert.match(summary.notes[0], /Poule 4 : B — Retrait médical/);
  assert.equal(logs[0].action, 'Statut de tireur relevé sur le suivi officiel');
});

test('club requests: three severe refusals block new requests, and at most three a day', async () => {
  const moderation = require('../src/services/clubModeration');
  const state = { requests: [], logs: [] };
  const tx = {
    clubRegistrationRequest: {
      findMany: async ({ where }) =>
        state.requests.filter((r) => r.userId === where.userId && r.status === where.status),
      count: async () => state.requests.filter((r) => Date.now() - r.createdAt < 24 * 3600000).length,
      create: async ({ data }) => (
        state.requests.push({ id: state.requests.length + 1, createdAt: Date.now(), status: 'PENDING', ...data }),
        state.requests.at(-1)
      ),
    },
    auditLog: {
      findMany: async ({ where }) =>
        state.logs.filter((l) => where.targetId.in.includes(l.targetId) && where.action.in.includes(l.action)),
      create: async ({ data }) => state.logs.push(data),
    },
    clubNamePolicy: { findUnique: async () => null, upsert: async () => ({ revision: 0, terms: [] }) },
  };
  // Trois refus graves anciens.
  for (const id of [1, 2, 3]) {
    state.requests.push({ id, userId: 7, status: 'REJECTED', createdAt: Date.now() - 5 * 86400000 });
    state.logs.push({ action: 'CLUB_REQUEST_SEVERE', targetType: 'ClubRegistrationRequest', targetId: id });
  }
  assert.equal(await moderation.severeRefusals(tx, 7), 3);
  await assert.rejects(moderation.submit(tx, 7, { name: 'Cercle X', city: 'Paris' }), /plus proposer/);
  state.logs.pop();
  assert.equal(await moderation.severeRefusals(tx, 7), 2);
  // Limite quotidienne.
  state.requests.push(...[4, 5, 6].map((id) => ({ id, userId: 7, status: 'CANCELLED', createdAt: Date.now() })));
  await assert.rejects(moderation.submit(tx, 7, { name: 'Cercle X', city: 'Paris' }), /par jour/);
  const { refusalMessage } = require('../src/services/clubRequestEmail');
  const mail = refusalMessage(
    { id: 9, name: 'Nom choquant', city: 'Ville', reason: 'Nom inapproprié.' },
    { hideName: true },
  );
  assert.ok(
    !mail.subject.includes('Nom choquant') &&
      !mail.text.includes('Nom choquant') &&
      !mail.html.includes('Nom choquant'),
  );
  assert.ok(refusalMessage({ id: 9, name: 'Cercle', city: 'Ville', reason: 'Doublon.' }).text.includes('Cercle'));
  assert.ok(!refusalMessage({ id: 9, name: 'Cercle', city: 'Ville', reason: 'Doublon.' }).subject.includes('Cercle'));
});

test('one admin alert per club request: sent as soon as e-mail or push went out', async () => {
  const { alertAdmins } = require('../src/services/clubRequestMail');
  const row = { id: 4, status: 'PENDING', adminAlertStatus: 'PENDING', adminAlertAttempts: 0 };
  const updates = [];
  const db = {
    $transaction: async (fn) =>
      fn({
        $queryRaw: async () => [],
        clubRegistrationRequest: { updateMany: async () => ({}), findFirst: async () => row, update: async () => ({}) },
      }),
    clubRegistrationRequest: { update: async ({ data }) => updates.push(data) },
  };
  // E-mail parti, aucun téléphone abonné : plus de renvoi.
  assert.equal(await alertAdmins(db, async () => ({ mail: 1, push: 0 })), 1);
  assert.equal(updates.at(-1).adminAlertStatus, 'SENT');
});
