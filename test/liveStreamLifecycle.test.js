const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const live = require('../src/services/ftlLiveScores');
const router = require('../src/routes/publicRoutes');
const handler = router.stack.find((layer) => layer.route?.path === '/competitions/:competitionId/live/stream').route
  .stack[0].handle;
function response() {
  const res = new EventEmitter();
  res.set = () => res;
  res.flushHeaders = () => {};
  res.flush = () => {};
  return res;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('client fermé pendant l’abonnement : désabonnement dès sa résolution, sans lecture ni envoi', async () => {
  const oldFor = live.liveFor,
    oldSubscribe = live.subscribe;
  let resolveSubscribe,
    unsubscribed = 0,
    reads = 0;
  live.subscribe = () =>
    new Promise((resolve) => {
      resolveSubscribe = resolve;
    });
  live.liveFor = async () => {
    reads++;
    return [];
  };
  const req = new EventEmitter();
  req.params = { competitionId: '20' };
  req.query = {};
  const res = response();
  res.write = () => assert.fail('client déjà fermé');
  try {
    const pending = handler(req, res);
    req.emit('close');
    resolveSubscribe(() => unsubscribed++);
    await pending;
    assert.equal(unsubscribed, 1);
    assert.equal(reads, 0);
  } finally {
    req.emit('close');
    live.liveFor = oldFor;
    live.subscribe = oldSubscribe;
  }
});
test('client lent : 1000 changements regroupés, état final et touches conservés après drain', async () => {
  const oldFor = live.liveFor,
    oldSubscribe = live.subscribe;
  let notify,
    reads = 0,
    blocked = true,
    unsubscribed = 0;
  let rows = [{ matchId: 1, score1: 1, history: [{ l: 1, r: 0 }] }];
  live.subscribe = async (_db, _id, cb) => {
    notify = cb;
    return () => unsubscribed++;
  };
  live.liveFor = async () => {
    reads++;
    return structuredClone(rows);
  };
  const req = new EventEmitter();
  req.params = { competitionId: '20' };
  req.query = { delta: '1' };
  const res = response(),
    frames = [];
  res.write = (frame) => {
    frames.push(JSON.parse(frame.slice(6)));
    return !blocked;
  };
  try {
    await handler(req, res);
    await tick();
    assert.equal(frames.length, 1);
    rows = [
      {
        matchId: 1,
        score1: 2,
        history: [
          { l: 1, r: 0 },
          { l: 2, r: 0 },
        ],
      },
    ];
    for (let i = 0; i < 1000; i++) notify();
    await tick();
    assert.equal(frames.length, 1);
    assert.equal(reads, 1);
    blocked = false;
    res.emit('drain');
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(frames.length, 2);
    assert.equal(reads, 2);
    assert.deepEqual(frames[1].matches, [{ matchId: 1, score1: 2, historyFrom: 1, historyAppend: [{ l: 2, r: 0 }] }]);
    req.emit('close');
    assert.equal(unsubscribed, 1);
  } finally {
    req.emit('close');
    live.liveFor = oldFor;
    live.subscribe = oldSubscribe;
  }
});
