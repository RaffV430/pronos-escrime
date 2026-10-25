const test = require('node:test');
const assert = require('node:assert/strict');
const { teamLiveRows, genderOf } = require('../src/services/teamLiveOverview');
const now = Date.now();
const women = {
  id: 1,
  tournamentId: 7,
  podiumFormat: 'TEAM',
  name: "Junior Team Women's Foil",
  podiumRoster: [
    { id: 'fr', name: 'FRANCE', country: 'FRA', members: ['MARTIN Léa', 'ROUX Zoé'] },
    { id: 'it', name: 'ITALY', country: 'ITA', members: ['ROSSI Anna'] },
  ],
};
const men = {
  ...women,
  id: 2,
  name: "Junior Team Men's Foil",
  podiumRoster: [
    { id: 'fr', name: 'FRANCE', country: 'FRA', members: ['MARTIN Léo'] },
    { id: 'it', name: 'ITALY', country: 'ITA', members: ['ROSSI Marco'] },
  ],
};
const state = {
  at: now,
  strip: 'Bleue',
  clock: 92,
  period: 5,
  left: { name: 'MARTIN Léa', country: 'FRA', score: 21 },
  right: { name: 'ROSSI Anna', country: 'ITA', score: 18 },
};
const match = { id: 10, competitionId: 1, strip: 'Bleue', round: 'T8', player1: 'ITALY', player2: 'FRANCE' };
test('simultaneous women and men with the same nations are distinguished by current relay members', () => {
  const other = {
    ...state,
    strip: 'Rouge',
    left: { name: 'MARTIN Léo', country: 'FRA', score: 5 },
    right: { name: 'ROSSI Marco', country: 'ITA', score: 7 },
  };
  const rows = teamLiveRows([women, men], [match], [state, other], now);
  assert.deepEqual(
    rows.map((r) => [r.competitionId, r.gender]),
    [
      [1, 'women'],
      [2, 'men'],
    ],
  );
  assert.equal(rows[0].officialMatchId, 10);
  assert.equal(rows[0].player1, 'FRANCE');
  assert.equal(rows[0].score1, 21);
  assert.equal(rows[0].fencer1.name, 'MARTIN Léa');
});
test('unimported classification bouts are display-only with no invented round or match identifier', () => {
  const [r] = teamLiveRows([women], [], [state], now);
  assert.equal(r.officialMatchId, null);
  assert.equal(r.round, null);
  assert.match(r.matchId, /^team-live:/);
});
test('ambiguity, unknown relay members, wrong countries, stale signal and published results are excluded', () => {
  assert.deepEqual(teamLiveRows([women, { ...women, id: 3 }], [], [state], now), []);
  assert.deepEqual(teamLiveRows([women], [], [{ ...state, left: { ...state.left, name: 'INCONNU' } }], now), []);
  assert.deepEqual(teamLiveRows([women], [], [{ ...state, left: { ...state.left, country: 'GER' } }], now), []);
  assert.deepEqual(teamLiveRows([women], [], [state], now + 180001), []);
  assert.deepEqual(teamLiveRows([women], [{ ...match, isFinished: true }], [state], now), []);
  assert.deepEqual(teamLiveRows([women], [match, { ...match, id: 11 }], [state], now), []);
});
test('relay and left/right changes use the names transmitted now and preserve a stable official encounter key', () => {
  const first = teamLiveRows([women], [match], [state], now)[0];
  const changed = { ...state, left: state.right, right: { ...state.left, name: 'ROUX Zoé' } };
  const next = teamLiveRows([women], [match], [changed], now)[0];
  assert.equal(first.matchId, next.matchId);
  assert.equal(next.fencer2.name, 'ROUX Zoé');
  assert.equal(next.player1, 'ITALY');
  assert.equal(next.score1, 18);
  assert.equal(match.player1, 'ITALY');
});
test('gender matching never confuses women with men and preserves unknown labels', () => {
  assert.equal(genderOf(women.name), 'women');
  assert.equal(genderOf(men.name), 'men');
  assert.equal(genderOf('Fleuret Dames par équipes'), 'women');
  assert.equal(genderOf('Fleuret Hommes par équipes'), 'men');
  assert.equal(genderOf('Équipe'), 'unknown');
});

test('tournament overview is bounded to the source tournament, cached and performs no writes', async () => {
  const live = require('../src/services/ftlLiveScores');
  const guid = 'A'.repeat(32);
  let contexts = 0,
    matchesRead = 0;
  const db = {
    competition: {
      findUnique: async () => ({
        tournamentId: 7,
        podiumFormat: 'TEAM',
        tournament: { ftlSourceUrl: `https://www.fencingtimelive.com/tournaments/eventSchedule/${guid}` },
      }),
      findMany: async ({ where }) => {
        assert.deepEqual(where, { tournamentId: 7, podiumFormat: 'TEAM' });
        contexts++;
        return [women, men];
      },
    },
    match: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { competitionId: { in: [1, 2] } });
        matchesRead++;
        return [match];
      },
    },
  };
  const key = `${guid}:Bleue`;
  live._strips.set(key, { ...state, guid });
  live._strips.set('other:Bleue', { ...state, guid: 'B'.repeat(32) });
  try {
    const rows = await live.teamOverviewFor(db, 987654, now);
    assert.equal(rows.length, 1);
    await live.teamOverviewFor(db, 987654, now + 500);
    assert.equal(contexts, 1);
    assert.equal(matchesRead, 1);
    const stale = await live.teamOverviewFor(db, 987654, now + 180001);
    assert.equal(stale.length, 0);
  } finally {
    live._strips.delete(key);
    live._strips.delete('other:Bleue');
  }
});
