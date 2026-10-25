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

test('ping bloqué pendant la lecture : instantané et delta repris sans perdre leur état', async () => {
  const oldFor = live.liveFor,
    oldSubscribe = live.subscribe,
    oldInterval = global.setInterval;
  try {
    for (const delta of [false, true]) {
      let resolveRows,
        notify,
        ping,
        reads = 0,
        unsubscribed = 0;
      const rows = [{ matchId: 1, score1: 2, history: [{ l: 2, r: 0 }] }];
      live.subscribe = async (_db, _id, cb) => {
        notify = cb;
        return () => unsubscribed++;
      };
      live.liveFor = async () => {
        reads++;
        return reads === 1
          ? new Promise((resolve) => {
              resolveRows = resolve;
            })
          : structuredClone(rows);
      };
      global.setInterval = (fn, ms) => {
        ping = fn;
        return oldInterval(() => {}, ms);
      };
      const req = new EventEmitter();
      req.params = { competitionId: '20' };
      req.query = delta ? { delta: '1' } : {};
      const res = response(),
        frames = [];
      res.write = (frame) => {
        frames.push(frame);
        return !frame.startsWith(': ping');
      };
      try {
        await handler(req, res);
        ping();
        resolveRows(structuredClone(rows));
        await tick();
        assert.deepEqual(frames, [': ping\n\n']);
        res.emit('drain');
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(reads, 2);
        assert.equal(frames.length, 2);
        const packet = JSON.parse(frames[1].slice(6));
        if (delta) {
          assert.equal(packet.reset, true);
          assert.deepEqual(packet.matches, rows);
        } else assert.deepEqual(packet, rows);
        notify();
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(frames.length, 2, 'aucun doublon après la reprise');
      } finally {
        req.emit('close');
      }
      assert.equal(unsubscribed, 1);
    }
  } finally {
    live.liveFor = oldFor;
    live.subscribe = oldSubscribe;
    global.setInterval = oldInterval;
  }
});

test('teams=1 uses the display-only overview through the existing delta stream and unsubscribes normally', async () => {
  const oldTeam = live.teamOverviewFor,
    oldFor = live.liveFor,
    oldSubscribe = live.subscribe;
  let reads = 0,
    closed = 0;
  const frames = [];
  live.teamOverviewFor = async (_db, id) => {
    assert.equal(id, 45);
    reads++;
    return [{ matchId: 'team-live:45:A', score1: 21, competitionId: 45, fencer1: { name: 'MARTIN Léa' } }];
  };
  live.liveFor = async () => assert.fail('not the prediction/live-lock stream');
  live.subscribe = async () => () => closed++;
  const req = new EventEmitter();
  req.params = { competitionId: '45' };
  req.query = { teams: '1', delta: '1' };
  const res = response();
  res.write = (frame) => (frames.push(JSON.parse(frame.slice(6))), true);
  try {
    await handler(req, res);
    await tick();
    assert.equal(reads, 1);
    assert.equal(frames[0].matches[0].fencer1.name, 'MARTIN Léa');
    req.emit('close');
    assert.equal(closed, 1);
  } finally {
    req.emit('close');
    live.teamOverviewFor = oldTeam;
    live.liveFor = oldFor;
    live.subscribe = oldSubscribe;
  }
});
