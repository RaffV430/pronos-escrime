// Réglages de notification du compte, exempts du tableau et clôture d'un tour déjà commencé.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const { preferences } = require('../src/services/playerExperience');
const push = require('../src/services/pushNotifications');
const { closesAt, matchClosed, roundContext } = require('../src/lib/matchLock');
const { parseTable } = require('../src/services/ftlParser');

test('old settings keep the same notifications after the upgrade', () => {
  // « Uniquement Mes tireurs » + récap : recevait les résultats de ses tireurs, pas ses bilans.
  const old = preferences({ fencersOnly: true, recap: true, roundResults: false });
  assert.equal(old.fencerResults, true);
  assert.equal(old.recap, false);
  assert.equal(old.roundResults, false);
  assert.equal(old.v, 2);
  // Sans « Mes tireurs » : rien ne change, pas de résultats de tireurs imposés.
  const plain = preferences({ recap: true });
  assert.equal(plain.fencerResults, false);
  assert.equal(plain.recap, true);
  // Réglages déjà en version 2 : lus tels quels.
  const v2 = preferences({ v: 2, fencersOnly: true, recap: true, fencerResults: false });
  assert.equal(v2.recap, true);
  assert.equal(v2.fencerResults, false);
  assert.throws(() => preferences({ v: 2, fencerResults: 'oui' }), /invalide/);
});

function fakeDb(state) {
  const tx = {
    $queryRaw: async () => [],
    user: {
      update: async ({ data }) => Object.assign(state.user, data),
      findUnique: async () => state.user,
    },
    tournament: { count: async ({ where }) => where.id.in.length },
    competition: { count: async ({ where }) => where.id.in.length },
    pushSubscription: {
      findMany: async ({ where }) =>
        state.subs.filter((s) => s.userId === where.userId && s.enabled && (!where.id || s.id !== where.id.not)),
      findFirst: async () => state.subs[0] || null,
      updateMany: async ({ where, data }) => {
        for (const s of state.subs) if (where.id.in.includes(s.id)) Object.assign(s, data);
        return { count: where.id.in.length };
      },
    },
    pushDelivery: {
      updateMany: async ({ where }) => {
        state.cancelled.push(...where.subscriptionId.in);
        return { count: 1 };
      },
    },
  };
  return { ...tx, $transaction: async (fn) => fn(tx) };
}

test('saving the account settings applies them to every device of the player', async () => {
  const state = {
    user: { notificationSettings: null },
    cancelled: [],
    subs: [
      { id: 'phone', userId: 7, enabled: true, preferences: preferences({}), tournamentIds: [], competitionIds: [] },
      { id: 'laptop', userId: 7, enabled: true, preferences: preferences({}), tournamentIds: [], competitionIds: [] },
      { id: 'other', userId: 8, enabled: true, preferences: preferences({}), tournamentIds: [], competitionIds: [] },
    ],
  };
  const out = await push.saveSettings(fakeDb(state), 7, {
    preferences: { ...preferences({}), fencerResults: true, timezone: 'Europe/Paris' },
    tournamentIds: [],
    competitionIds: [],
  });
  assert.equal(out.devices, 2);
  assert.equal(state.subs[0].preferences.fencerResults, true);
  assert.equal(state.subs[1].preferences.fencerResults, true);
  assert.equal(state.subs[2].preferences.fencerResults, false);
  assert.deepEqual(state.cancelled.sort(), ['laptop', 'phone']);
  assert.equal(state.user.notificationSettings.preferences.fencerResults, true);
  const read = await push.accountSettings(fakeDb(state), 7);
  assert.equal(read.preferences.fencerResults, true);
  // Mêmes réglages une seconde fois : aucun appareil modifié, aucune alerte annulée.
  state.cancelled = [];
  const again = await push.saveSettings(fakeDb(state), 7, {
    preferences: { ...preferences({}), fencerResults: true },
    tournamentIds: [],
    competitionIds: [],
  });
  assert.equal(again.devices, 0);
  assert.deepEqual(state.cancelled, []);
});

test('a round closes as soon as its first bout result is published', () => {
  const t = (h, m) => new Date(Date.UTC(2026, 9, 17, h, m)).toISOString();
  const rounds = [
    { competitionId: 1, round: 'T16', previousRound: null, expectedMatchCount: 1 },
    { competitionId: 1, round: 'T8', previousRound: 'T16', expectedMatchCount: 2 },
  ];
  const base = [
    // T16 terminé en retard (14 h 15 UTC) : clôture du T8 repoussée à 14 h 25 au lieu de 14 h 10.
    { id: 1, competitionId: 1, round: 'T16', isFinished: true, resultRegisteredAt: t(14, 15) },
    { id: 2, competitionId: 1, round: 'T8', isFinished: false, startsAt: t(14, 10) },
    { id: 3, competitionId: 1, round: 'T8', isFinished: false, startsAt: t(14, 10) },
  ];
  const [, open] = roundContext(base, rounds);
  assert.equal(closesAt(open), t(14, 25));
  assert.equal(matchClosed(open, Date.parse(t(14, 20))), false);
  // Un premier assaut du T8 se termine à 14 h 21 : l'autre match du T8 ferme aussitôt.
  const started = base.map((m) => (m.id === 3 ? { ...m, isFinished: true, resultRegisteredAt: t(14, 21) } : m));
  const other = roundContext(started, rounds)[1];
  assert.equal(closesAt(other), t(14, 21));
  assert.equal(matchClosed(other, Date.parse(t(14, 22))), true);
  assert.equal(matchClosed(other, Date.parse(t(14, 20))), false);
});

test('tableau byes are read from the official tableau', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'ftl-individual-partial.html'), 'utf8');
  const $ = load(html);
  const roster = [
    ...new Set(
      $('.tbb,.tbbr')
        .toArray()
        .map((e) =>
          $(e)
            .find('.tcln,.tcfn')
            .map((i, n) => $(n).text())
            .get()
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter((n) => n && n !== '- BYE -'),
    ),
  ].map((name) => ({ name }));
  const { byes } = parseTable(html, { date: '2026-09-27', roster, maxScore: 15, requireComplete: false });
  assert.deepEqual(byes[0], { round: 'T256', pos: 1, name: 'WANG Yiran' });
  assert.ok(byes.every((b) => b.round === 'T256' && Number.isInteger(b.pos) && b.name));
});
