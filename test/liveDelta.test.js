const test = require('node:test');
const assert = require('node:assert/strict');
const { liveDelta } = require('../src/services/liveDelta');
const touch = (score1) => ({ score1, score2: 0, by: 1, at: '2026-01-01T00:00:00Z' });
const row = { matchId: 1, score1: 1, score2: 0, clock: 150, fencer1: { light: 'red' }, history: [touch(1)] };
test('initial/reconnexion complet, changement immédiat score et lampe, historique incrémental', () => {
  const initial = liveDelta(null, [row]);
  assert.equal(initial.message.reset, true);
  assert.deepEqual(initial.message.matches, [row]);
  const newer = { ...row, score1: 2, fencer1: { light: null }, history: [...row.history, touch(2)] };
  const diff = liveDelta(initial.next, [newer]);
  assert.deepEqual(diff.message.matches, [
    { matchId: 1, score1: 2, fencer1: { light: null }, historyFrom: 1, historyAppend: [touch(2)] },
  ]);
  assert.equal(liveDelta(diff.next, [newer]).message, null);
  assert.deepEqual(row.history, [touch(1)]);
});
test('correction et réorientation remplacent le déroulé ; disparition supprime le match', () => {
  const initial = liveDelta(null, [row]);
  const corrected = { ...row, history: [{ ...touch(1), by: 2 }] };
  assert.deepEqual(liveDelta(initial.next, [corrected]).message.matches[0].history, corrected.history);
  assert.deepEqual(liveDelta(initial.next, []).message.removed, [1]);
  const finished = { matchId: 1, finished: true, history: [], historyIssue: 'Résultat contradictoire' };
  const patch = liveDelta(initial.next, [finished]).message.matches[0];
  assert.equal(patch.score1, null);
  assert.equal(patch.fencer1, null);
  assert.deepEqual(patch.history, []);
});
test('une mise à jour ne renvoie pas les autres rencontres et réduit fortement les octets', () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({
    ...row,
    matchId: i + 1,
    history: Array.from({ length: 20 }, (_, j) => touch(j)),
  }));
  const before = liveDelta(null, rows);
  const after = rows.map((m, i) => (i ? m : { ...m, clock: 149, fencer1: { light: 'white' } }));
  const delta = liveDelta(before.next, after).message;
  assert.equal(delta.matches.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(after)) / 20);
});
