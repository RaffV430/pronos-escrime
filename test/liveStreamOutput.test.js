const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { liveStreamOutput } = require('../src/services/liveStreamOutput');
test('client lent : une seule trame en attente, reprise au drain et fermeture sans écriture', () => {
  const res = new EventEmitter();
  const frames = [];
  let drained = 0;
  res.write = (frame) => {
    frames.push(frame);
    return false;
  };
  const stream = liveStreamOutput(res, () => drained++);
  assert.equal(stream.write('première'), true);
  for (let i = 0; i < 1000; i++) assert.equal(stream.write('obsolète'), false);
  assert.deepEqual(frames, ['première']);
  res.emit('drain');
  assert.equal(drained, 1);
  assert.equal(stream.write('dernier état'), true);
  stream.close();
  res.emit('drain');
  assert.equal(drained, 1);
  assert.equal(stream.write('après fermeture'), false);
  assert.equal(res.listenerCount('drain'), 0);
});
