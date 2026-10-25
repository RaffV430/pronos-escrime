const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeTeamHistory } = require('../src/services/teamRelayHistory');
const at = (n) => new Date(1700000000000 + n).toISOString();
const event = (score1, score2, n, extra = {}) => ({ score1, score2, at: at(n), period: 1, by: 1, ...extra });
const names = { fencer1Name: 'SYNTH A', fencer2Name: 'SYNTH B' };
test('preserves recorded relay segments and separates a change without inventing a touch', () => {
  let h = mergeTeamHistory([], [event(3, 2, 1, { by: 'start' }), event(4, 2, 2)], { ...event(4, 2, 2), ...names });
  const original = structuredClone(h);
  h = mergeTeamHistory(h, [event(4, 2, 3, { period: 2, by: 'start' })], {
    ...event(4, 2, 3, { period: 2 }),
    ...names,
    fencer1Name: 'SYNTH C',
  });
  assert.deepEqual(h.slice(0, 2), original);
  assert.equal(h.at(-1).by, 'relay');
  assert.equal(h.at(-1).fencer1Name, 'SYNTH C');
  const same = mergeTeamHistory(h, [event(4, 2, 3, { period: 2, by: 'start' })], h.at(-1));
  assert.deepEqual(same, h);
  h = mergeTeamHistory(h, [event(5, 2, 4, { period: 2 })], {
    ...event(5, 2, 4, { period: 2 }),
    ...names,
    fencer1Name: 'SYNTH C',
  });
  assert.equal(h.at(-1).score1, 5);
  assert.equal(h.filter((x) => x.by === 'relay').length, 1);
});
test('gaps, corrections, empty starts and bounded truncation remain explicit', () => {
  let h = mergeTeamHistory([], [], { ...event(0, 0, 0), ...names });
  assert.equal(h[0].by, 'start');
  h = mergeTeamHistory(h, [event(3, 0, 1)], { ...event(3, 0, 1), ...names });
  assert.equal(h.at(-1).by, 'gap');
  h = mergeTeamHistory(h, [event(2, 0, 2, { by: 'correction' })], { ...event(2, 0, 2), ...names });
  assert.equal(h.at(-1).by, 'correction');
  h = mergeTeamHistory(h, [event(3, 0, 3)], { ...event(3, 0, 3), ...names }, 3);
  assert.equal(h.length, 3);
  assert.equal(h[0].truncated, true);
});
test('periods present in a collected segment are not replaced by the current relay', () => {
  const h = mergeTeamHistory([], [event(1, 0, 1), event(2, 0, 2, { period: 2 })], {
    ...event(2, 0, 2, { period: 2 }),
    ...names,
  });
  assert.equal(h[0].period, 1);
  assert.equal(h.find((x) => x.by === 'relay').period, 2);
});
test('an older snapshot cannot roll back a retained score', () => {
  const current = { ...event(5, 4, 4), ...names };
  const h = mergeTeamHistory([], [], current);
  assert.deepEqual(mergeTeamHistory(h, [], { ...event(2, 1, 1), ...names }), h);
});
