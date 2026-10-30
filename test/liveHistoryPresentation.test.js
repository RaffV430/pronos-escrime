const { test } = require('node:test');
const assert = require('node:assert/strict');
const { presentLiveHistory } = require('../src/services/liveHistoryPresentation');
const match = { isFinished: true, podiumFormat: 'TEAM', score1: 32, score2: 27 };
const event = (score1, score2, period, by = 1) => ({ score1, score2, period, by });
const raw = [
  event(31, 27, 9),
  event(32, 27, 9),
  event(32, 27, 1, 'relay'),
  event(5, 3, 1, 'correction'),
  event(5, 3, 1, 'gap'),
];
test('confirmed team final hides the late relay reset without mutating raw observations', () => {
  const original = structuredClone(raw),
    m = structuredClone(match);
  const result = presentLiveHistory(match, raw);
  assert.deepEqual(result.history, raw.slice(0, 2));
  assert.ok(result.historyNotice);
  assert.equal(result.historyIssue, null);
  assert.deepEqual(raw, original);
  assert.deepEqual(match, m);
});
test('uncertain final, unfinished bout, different format and unknown periods never trigger reset filtering', () => {
  for (const m of [
    { ...match, isFinished: false },
    { ...match, pointsPending: true },
    { ...match, score1: 33 },
    { ...match, score1: null },
    { ...match, podiumFormat: 'INDIVIDUAL' },
  ])
    assert.deepEqual(presentLiveHistory(m, raw).history, raw);
  const unknown = raw.map((e) => ({ ...e, period: null }));
  assert.deepEqual(presentLiveHistory(match, unknown).history, unknown);
});
test('real corrections before the final and a restored relay label are preserved', () => {
  const h = [event(31, 27, 9), event(30, 27, 9, 'correction'), event(32, 27, 9)];
  assert.deepEqual(presentLiveHistory(match, h).history, h);
  const restored = [...raw, event(32, 27, 9, 'correction')];
  assert.deepEqual(presentLiveHistory(match, restored).history, restored);
  const early = [event(12, 11, 5), event(5, 3, 1, 'correction')];
  assert.deepEqual(presentLiveHistory(match, early).history, early);
});
test('side inversion and zero losing score do not change the reset decision', () => {
  const reversed = raw.map((e) => ({ ...e, score1: e.score2, score2: e.score1 }));
  assert.equal(presentLiveHistory({ ...match, score1: 27, score2: 32 }, reversed).history.length, 2);
  assert.equal(
    presentLiveHistory({ ...match, score1: 45, score2: 0 }, [event(45, 0, 9), event(0, 0, 1, 'correction')]).history
      .length,
    1,
  );
});
test('empty and incomplete histories stay explicit; incompatible scores remain hidden', () => {
  assert.deepEqual(presentLiveHistory(match, []).history, []);
  assert.deepEqual(presentLiveHistory(match, [event(12, 11, 5)]).history, [event(12, 11, 5)]);
  assert.ok(presentLiveHistory(match, [event(40, 27, 9)]).historyIssue);
  assert.equal(presentLiveHistory(match, [event(40, 27, 9)]).history.length, 0);
});
