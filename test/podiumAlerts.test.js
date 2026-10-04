// Tireur pronostiqué sur un podium et sorti de la compétition : les joueurs concernés sont prévenus.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { alertPodiumOut, podiumOutNotification } = require('../src/services/podiumAlerts');

const roster = ['a', 'b', 'c', 'd', 'x'].map((id) => ({ id, name: `NOM ${id.toUpperCase()}`, active: true }));
const c = { id: 11, name: 'Fleuret Hommes senior', tournamentId: 3, podiumFormat: 'INDIVIDUAL', podiumRoster: roster };

function fakeDb({ matches = [] } = {}) {
  const created = [];
  return {
    created,
    match: { findMany: async () => matches },
    podiumPrediction: {
      findMany: async () => [
        { id: 1, userId: 7, selectionIds: { gold: 'x', silver: 'a', bronze1: 'b', bronze2: 'c' } },
        { id: 2, userId: 8, selectionIds: { gold: 'a', silver: 'b', bronze1: 'c', bronze2: 'd' } },
      ],
    },
    pushSubscription: { findMany: async ({ where }) => where.userId.in.map((u) => ({ id: `s${u}` })) },
    pushDelivery: {
      createMany: async ({ data }) => {
        created.push(...data);
        return { count: data.length };
      },
    },
  };
}

test('seuls les joueurs ayant le tireur sur leur podium sont prévenus', async () => {
  const db = fakeDb();
  assert.equal(await alertPodiumOut(db, c, [{ id: 'x', status: 'DNS' }]), 1);
  assert.deepEqual(
    db.created.map((d) => [d.subscriptionId, d.kind, d.round]),
    [['s7', 'PODIUM_OUT', 'podium-out-DNS-x']],
  );
});

test('podium déjà bloqué (tableau commencé) ou résolu : aucune alerte', async () => {
  const started = [{ id: 1, round: 'T64', startsAt: new Date(Date.now() - 60000), isFinished: false }];
  assert.equal(await alertPodiumOut(fakeDb({ matches: started }), c, [{ id: 'x', status: 'DNS' }]), 0);
  assert.equal(await alertPodiumOut(fakeDb(), { ...c, podiumResolvedAt: new Date() }, [{ id: 'x', status: 'DNS' }]), 0);
});

test('texte de la notification', () => {
  const n = podiumOutNotification(c, roster[4], 'forfait');
  assert.equal(n.title, '⚠ Podium à revoir · Fleuret Hommes senior');
  assert.match(n.body, /NOM X ne disputera pas le tableau \(forfait\)/);
  assert.match(n.url, /view=podium/);
});
