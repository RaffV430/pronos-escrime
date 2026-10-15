const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const live = require('../src/services/ftlLiveScores');
test('HTTP : le paramètre delta active le protocole et garde les anciens écrans compatibles', async () => {
  const oldFor = live.liveFor,
    oldSubscribe = live.subscribe;
  live.liveFor = async () => [{ matchId: 90001, score1: 2, history: [] }];
  live.subscribe = async () => () => {};
  const app = express();
  app.use(require('../src/routes/publicRoutes'));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const suffix of ['?delta=1', '']) {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.address().port}/competitions/20/live/stream${suffix}`, {
        signal: controller.signal,
      });
      assert.equal(response.headers.get('x-live-protocol'), suffix ? 'delta-v1' : 'snapshot');
      const { value } = await response.body.getReader().read();
      const data = JSON.parse(new TextDecoder().decode(value).trim().slice(6));
      if (suffix) {
        assert.equal(data.reset, true);
        assert.equal(data.matches[0].score1, 2);
      } else assert.equal(data[0].score1, 2);
      controller.abort();
    }
  } finally {
    live.liveFor = oldFor;
    live.subscribe = oldSubscribe;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
