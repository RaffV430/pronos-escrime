const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeBadges } = require('../src/services/badges');

const at = (i) => new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString();
const row = (matchId, outcome, extra = {}) => ({
  type: 'Match',
  matchId,
  competitionId: extra.competitionId || 10,
  outcome,
  points: outcome === 'exact' ? 4 : outcome === 'points' ? 1 : 0,
  bonus: 0,
  resultAt: at(matchId),
  ...extra,
});
const season = (t1Rows, t2Rows = []) => ({
  tournaments: [
    { id: 1, name: 'Challenge de Paris', competitions: [{ id: 10, name: 'Fleuret hommes', rows: t1Rows }] },
    { id: 2, name: 'Coupe de Lyon', competitions: [{ id: 20, name: 'Fleuret dames', rows: t2Rows }] },
  ],
});
const ids = (badges) => badges.filter((b) => b.count > 0).map((b) => `${b.id}:${b.count}`);
const empty = { userId: 7, matches: [], predictions: [] };

test('Sniper : scores exacts cumulés sur la saison, niveaux 3 / 5 / 10 / 20', () => {
  const s = season([row(1, 'exact'), row(2, 'exact'), row(3, 'exact')], [row(4, 'exact', { competitionId: 20 })]);
  const b = computeBadges(s, empty);
  assert.deepEqual(ids(b), ['sniper:4']);
  const sniper = b.find((x) => x.id === 'sniper');
  assert.deepEqual([sniper.level, sniper.next, sniper.maxLevel], [1, 5, 4]);
  assert.equal(sniper.description, '3 scores exacts sur la saison');
  assert.equal(sniper.nextText, '5 scores exacts sur la saison');
  assert.deepEqual(sniper.where, ['Challenge de Paris', 'Coupe de Lyon']);
  assert.equal(b.length, 6, 'all trophies listed, earned or not');
  assert.deepEqual(ids(computeBadges(season([row(1, 'exact'), row(2, 'exact')]), empty)), []);
  const twenty = Array.from({ length: 20 }, (_, i) => row(i + 1, 'exact'));
  const top = computeBadges(season(twenty), empty).find((x) => x.id === 'sniper');
  assert.deepEqual([top.level, top.next, top.nextText], [4, null, null]);
});

test('Série : plus longue suite de bons vainqueurs, dans l’ordre des résultats ; niveaux 10 / 15 / 20 / 30', () => {
  const run = (pattern) => pattern.split('').map((c, i) => row(i + 1, c === 'x' ? 'miss' : 'points'));
  assert.deepEqual(ids(computeBadges(season(run('vvvvvvvvvv')), empty)), ['streak:10']);
  assert.deepEqual(ids(computeBadges(season(run('vvvvvvvvvxvvvvvvvvv')), empty)), []);
  const twenty = computeBadges(season(run('v'.repeat(20))), empty).find((x) => x.id === 'streak');
  assert.deepEqual([twenty.level, twenty.value, twenty.next], [3, 20, 30]);
  const shuffled = run('vvvvvvvvvv').map((r, i) => ({ ...r, resultAt: at(10 - i) }));
  shuffled.push({ ...row(99, 'miss'), resultAt: at(5) });
  assert.deepEqual(ids(computeBadges(season(shuffled), empty)), [], 'a miss in the middle of the chronology breaks it');
});

test('Flair: an outsider bonus', () => {
  assert.deepEqual(ids(computeBadges(season([row(1, 'points', { bonus: 1 })]), empty)), ['flair:1']);
});

test('Meilleur du tour: most points on a finished round, ties rewarded, needs 2 players', () => {
  const matches = [
    { id: 1, competitionId: 10, round: 'T16', isFinished: true, resultType: 'NORMAL' },
    { id: 2, competitionId: 10, round: 'T16', isFinished: true, resultType: 'NORMAL' },
    { id: 3, competitionId: 10, round: 'T8', isFinished: false, resultType: null },
  ];
  const p = (userId, matchId, pts, bonus = 0) => ({ userId, matchId, pointsEarned: pts, bonusPoints: bonus });
  const s = season([row(1, 'points'), row(2, 'exact')]);
  const best = computeBadges(s, {
    userId: 7,
    matches,
    predictions: [p(7, 1, 1), p(7, 2, 4), p(8, 1, 4), p(8, 2, 0, 1)],
  });
  assert.deepEqual(
    ids(best),
    ['sniper:0', 'bestRound:1'].filter((x) => !x.startsWith('sniper')),
  );
  assert.match(best.find((x) => x.id === 'bestRound').where[0], /Challenge de Paris · Fleuret hommes · T16/);
  const tie = computeBadges(s, { userId: 7, matches, predictions: [p(7, 1, 4), p(8, 1, 4)] });
  assert.deepEqual(ids(tie), ['bestRound:1']);
  assert.deepEqual(ids(computeBadges(s, { userId: 7, matches, predictions: [p(7, 1, 4)] })), [], 'alone');
  assert.deepEqual(
    ids(
      computeBadges(s, {
        userId: 7,
        matches: [{ ...matches[0], isFinished: false }, matches[1]],
        predictions: [p(7, 2, 4), p(8, 2, 1)],
      }),
    ),
    [],
    'round not finished',
  );
});

test('Assidu: every non-cancelled match of a finished tournament predicted', () => {
  const matches = [
    { id: 1, competitionId: 10, round: 'T16', isFinished: true, resultType: 'NORMAL' },
    { id: 2, competitionId: 10, round: 'T16', isFinished: true, resultType: 'NORMAL' },
    { id: 3, competitionId: 10, round: 'T16', isFinished: true, resultType: 'CANCELLED' },
  ];
  assert.deepEqual(
    ids(computeBadges(season([row(1, 'miss'), row(2, 'miss')]), { userId: 7, matches, predictions: [] })),
    ['assiduous:1'],
  );
  assert.deepEqual(ids(computeBadges(season([row(1, 'miss')]), { userId: 7, matches, predictions: [] })), []);
  const unfinished = matches.map((m) => (m.id === 2 ? { ...m, isFinished: false } : m));
  assert.deepEqual(
    ids(
      computeBadges(season([row(1, 'miss'), row(2, 'pending')]), { userId: 7, matches: unfinished, predictions: [] }),
    ),
    [],
  );
});

test('Voyant: a perfect podium (every medal exact), individual or team', () => {
  const podium = (perfect) => ({
    type: 'Podium',
    outcome: perfect ? 'exact' : 'points',
    points: perfect ? 60 : 50,
    perfect,
  });
  const b = computeBadges(season([podium(true)]), empty);
  assert.deepEqual(ids(b), ['seer:1']);
  assert.deepEqual(b.find((x) => x.id === 'seer').where, ['Challenge de Paris · Fleuret hommes']);
  assert.deepEqual(ids(computeBadges(season([podium(false)]), empty)), []);
});
