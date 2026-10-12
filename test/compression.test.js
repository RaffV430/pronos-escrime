// Les réponses JSON volumineuses sont compressées quand le navigateur l'accepte.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

test('large JSON answers are gzip-compressed', async () => {
  const app = express();
  app.use(require('compression')({ threshold: 1024 }));
  app.get('/big', (req, res) => res.json(Array.from({ length: 300 }, (_, i) => ({ id: i, player1: 'MARTIN Léa' }))));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const headers = await new Promise((resolve, reject) =>
      http
        .get({ port, path: '/big', headers: { 'accept-encoding': 'gzip' } }, (res) => {
          res.resume();
          resolve(res.headers);
        })
        .on('error', reject),
    );
    assert.equal(headers['content-encoding'], 'gzip');
  } finally {
    server.close();
  }
});
