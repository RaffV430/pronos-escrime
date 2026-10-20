const test = require('node:test');
const assert = require('node:assert/strict');
const { fencerSeason, seasonOf, summarize } = require('../src/services/fencerSeason');

test('the fencing season runs from September to August', () => {
  assert.equal(seasonOf('2026-10-11T09:00:00Z'), '2026-2027');
  assert.equal(seasonOf('2026-08-30T09:00:00Z'), '2025-2026');
  assert.equal(seasonOf('2026-09-01T09:00:00Z'), '2026-2027');
});

test('season summary: bouts, tableau, podiums and best result', () => {
  const s = summarize([
    {
      pools: [{ bouts: [{ won: true }, { won: false }] }],
      tableau: [{ won: true }],
      result: { place: 3, label: '3e' },
    },
    { pools: [], tableau: [{ won: false }], result: { place: null, label: 'Éliminé en T32', round: 'T32' } },
  ]);
  assert.deepEqual(
    [s.competitions, s.poolWins, s.poolLosses, s.tableauWins, s.tableauLosses, s.podiums, s.best.label],
    [2, 1, 1, 1, 1, 1, '3e'],
  );
});

function fakeDb() {
  const roster = (club) => [
    { id: 'a', name: 'MARTIN Léa', country: club },
    { id: 'b', name: 'DURAND Chloé', country: 'CE Melun' },
  ];
  const competitions = [
    {
      id: 1,
      name: 'M20 dames',
      createdAt: new Date('2026-10-10'),
      podiumFormat: 'INDIVIDUAL',
      podiumRoster: roster('CE Melun'),
      officialPodium: {},
      tournament: { id: 1, name: 'Étampes' },
    },
    // Homonyme d'un autre club : jamais mélangé.
    {
      id: 2,
      name: 'M20 dames',
      createdAt: new Date('2026-11-10'),
      podiumFormat: 'INDIVIDUAL',
      podiumRoster: roster('AS Lyon'),
      officialPodium: {},
      tournament: { id: 2, name: 'Lyon' },
    },
    {
      id: 3,
      name: 'M17 dames',
      createdAt: new Date('2026-03-10'),
      podiumFormat: 'INDIVIDUAL',
      podiumRoster: roster('CE Melun'),
      officialPodium: {},
      tournament: { id: 3, name: 'Paris' },
    },
  ];
  const match = (id, competitionId, startsAt, s1, s2) => ({
    id,
    competitionId,
    player1: 'MARTIN Léa',
    player2: 'DURAND Chloé',
    score1: s1,
    score2: s2,
    winner: s1 > s2 ? 1 : 2,
    isFinished: true,
    round: 'T32',
    startsAt: new Date(startsAt),
  });
  const matches = [
    match(10, 1, '2026-10-10T10:00Z', 15, 9),
    match(11, 2, '2026-11-10T10:00Z', 3, 15),
    match(12, 3, '2026-03-10T10:00Z', 15, 14),
  ];
  return {
    followedFencer: {
      findFirst: async () => ({ id: 5, userId: 1, name: 'MARTIN Léa', country: '', club: 'CE Melun' }),
    },
    competition: { findMany: async () => competitions },
    match: { findMany: async ({ where }) => matches.filter((m) => where.competitionId.in.includes(m.competitionId)) },
    pool: { findMany: async () => [] },
  };
}

test('a followed fencer season lists only her own events, homonyms of another club excluded', async () => {
  const db = fakeDb();
  const out = await fencerSeason(db, 1, 5, null);
  assert.deepEqual(out.seasons, ['2026-2027', '2025-2026']);
  assert.equal(out.season, '2026-2027');
  assert.deepEqual(
    out.competitions.map((c) => c.competitionId),
    [1],
  );
  const all = await fencerSeason(db, 1, 5, 'all');
  assert.deepEqual(
    all.competitions.map((c) => c.competitionId),
    [1, 3],
  );
  assert.equal(all.summary.tableauWins, 2);
  await assert.rejects(fencerSeason(db, 1, 5, '2026'), /Saison invalide/);
});

test('two spellings linked by the administration form one fencer history', async () => {
  const aliases = require('../src/services/fencerAliases');
  const store = {};
  const logs = [];
  const db = {
    ...fakeDb(),
    appSetting: {
      findUnique: async () => (store.value ? { value: store.value } : null),
      upsert: async ({ update }) => (store.value = update.value),
    },
    match: { count: async () => 1, findMany: fakeDb().match.findMany },
    poolFencer: { count: async () => 0 },
    auditLog: { create: async ({ data }) => logs.push(data) },
  };
  await assert.rejects(aliases.link(db, 1, 'MARTIN Léa', 'MARTIN Lea'), /déjà reconnues/);
  await aliases.link(db, 1, 'MARTIN Léa', 'MARTIN-DUPONT Léa');
  assert.deepEqual(await aliases.expand(db, 'martin léa'), ['martin léa', 'MARTIN Léa', 'MARTIN-DUPONT Léa']);
  await aliases.link(db, 1, 'MARTIN-DUPONT Léa', 'MARTIN DUPONT Lea Marie');
  assert.equal((await aliases.groups(db)).length, 1);
  assert.equal((await aliases.groups(db))[0].names.length, 3);
  await aliases.unlink(db, 1, 'MARTIN DUPONT Lea Marie');
  assert.equal((await aliases.groups(db))[0].names.length, 2);
  assert.equal(logs[0].action, 'Orthographes de tireur reliées');
  // Le parcours de la saison réunit l'épreuve inscrite sous l'autre orthographe.
  const competitions = await db.competition.findMany();
  competitions[2].podiumRoster[0].name = 'MARTIN-DUPONT Léa';
  const all = await fencerSeason(
    {
      ...db,
      competition: { findMany: async () => competitions },
      match: {
        findMany: async () => [
          {
            id: 12,
            competitionId: 3,
            player1: 'MARTIN-DUPONT Léa',
            player2: 'DURAND Chloé',
            score1: 15,
            score2: 14,
            winner: 1,
            isFinished: true,
            round: 'T32',
            startsAt: new Date('2026-03-10T10:00Z'),
          },
        ],
      },
    },
    1,
    5,
    'all',
  );
  assert.deepEqual(
    all.competitions.map((c) => c.competitionId),
    [3],
  );
});

test('épreuve terminée sans poule ni match importés (Samsun) : gardée ; épreuve à venir : écartée', async () => {
  const base = fakeDb();
  const competitions = await base.competition.findMany();
  const roster = competitions[0].podiumRoster;
  const db = {
    ...base,
    competition: {
      findMany: async () => [
        ...competitions,
        // Terminée (podium officiel), seulement la liste des engagés connue.
        {
          id: 7,
          name: 'Fleuret juniors',
          createdAt: new Date('2026-09-25'),
          podiumFormat: 'INDIVIDUAL',
          podiumRoster: roster,
          officialPodium: { gold: 'b' },
          podiumResolvedAt: new Date('2026-09-26'),
          tournament: { id: 7, name: 'Samsun' },
        },
        // À venir : inscrite, rien de disputé.
        {
          id: 8,
          name: 'M20 dames',
          createdAt: new Date('2026-10-15'),
          podiumFormat: 'INDIVIDUAL',
          podiumRoster: roster,
          officialPodium: {},
          tournament: { id: 8, name: 'Hammamet' },
        },
      ],
    },
  };
  const all = await fencerSeason(db, 1, 5, 'all');
  const ids = all.competitions.map((c) => c.competitionId);
  assert.ok(ids.includes(7), 'Samsun absent');
  assert.ok(!ids.includes(8), 'épreuve à venir affichée');
  assert.equal(all.competitions.find((c) => c.competitionId === 7).detailMissing, true);
  assert.equal('finished' in all.competitions[0], false);
});
