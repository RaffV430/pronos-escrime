// Import bloqué sans panne pendant une épreuve : alerte admin au 2e contrôle d'affilée, une seule fois
// pour les mêmes avertissements, puis « rétabli ».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { alertAttention, ATTENTION_ACTION } = require('../src/services/syncHealth');

function fake() {
  const logs = [];
  const sent = [];
  const db = {
    auditLog: {
      findFirst: async ({ where }) =>
        logs.filter((l) => where.action.in.includes(l.action) && l.targetId === where.targetId).at(-1) || null,
      create: async ({ data }) => {
        const l = { id: logs.length + 1, ...data };
        logs.push(l);
        return l;
      },
      update: async ({ where, data }) =>
        Object.assign(
          logs.find((l) => l.id === where.id),
          data,
        ),
    },
    competition: { findUnique: async () => ({ name: 'Fleuret Hommes senior', tournamentId: 3 }) },
    user: { findMany: async () => [{ id: 1, email: 'admin@exemple.test' }] },
    pushSubscription: { findMany: async () => [{ id: 's1' }] },
  };
  const deps = {
    mailer: { mailConfigured: () => false },
    push: { configured: () => true, send: async (s, content) => sent.push(content) },
  };
  return { db, deps, logs, sent };
}

test('alerte au 2e contrôle d’affilée, une fois, puis rétabli', async () => {
  const { db, deps, sent, logs } = fake();
  const w = ['Vainqueur incohérent au T256.'];
  const run = (previousStatus, warnings, duringEvent = true) =>
    alertAttention(db, { competitionId: 11, previousStatus, warnings, duringEvent }, deps);
  assert.equal(await run('READY', w), null, '1er contrôle : pas encore');
  assert.equal(await run('ATTENTION', w, false), null, 'avant l’épreuve : pas d’alerte');
  assert.equal((await run('ATTENTION', w)).kind, 'attention');
  assert.match(sent[0].title, /Import à vérifier · Fleuret Hommes senior/);
  assert.match(sent[0].body, /Vainqueur incohérent/);
  assert.equal(await run('ATTENTION', w), null, 'mêmes avertissements : pas de rappel');
  assert.equal((await run('ATTENTION', [...w, 'Poule 3 : composition'])).kind, 'attention', 'nouvel avertissement');
  assert.equal((await run('ATTENTION', [])).kind, 'recovered');
  assert.equal(await run('READY', []), null);
  assert.equal(logs.filter((l) => l.action === ATTENTION_ACTION).length, 2);
});
