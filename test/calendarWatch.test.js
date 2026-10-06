const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/services/calendarWatch');

const entry = (extra = {}) => ({
  id: '2026-10-17-henin-beaumont-senior-ind',
  start: '2026-10-17',
  end: '2026-10-18',
  city: 'Hénin-Beaumont',
  label: 'Épreuve nationale 1',
  weapon: 'Fleuret',
  gender: 'HD',
  categories: ['SENIOR'],
  format: 'INDIVIDUAL',
  ...extra,
});

test('calendrier : 54 épreuves validées, Hénin-Beaumont les 17 et 18 octobre', () => {
  const all = C.events();
  assert.equal(all.length, 54);
  const henin = all.find((e) => e.city === 'Hénin-Beaumont');
  assert.deepEqual([henin.start, henin.end, henin.gender], ['2026-10-17', '2026-10-18', 'HD']);
  assert.ok(all.every((e) => ['HD', 'H', 'F'].includes(e.gender) && e.start <= e.end));
});

test('intitulés officiels : arme, hommes / dames, catégorie, équipes', () => {
  assert.deepEqual(C.classify('Senior Men’s Foil'), {
    weapon: 'Fleuret',
    gender: 'H',
    category: 'SENIOR',
    team: false,
  });
  assert.deepEqual(C.classify("Junior Women's Foil Team"), {
    weapon: 'Fleuret',
    gender: 'F',
    category: 'M20',
    team: true,
  });
  assert.deepEqual(C.classify('Fleuret Dames M17'), { weapon: 'Fleuret', gender: 'F', category: 'M17', team: false });
  assert.equal(C.classify('Épée Hommes Senior').weapon, 'Épée');
  assert.equal(C.classify('Fleuret Hommes Vétérans V2').category, 'V');
});

test('épreuves retenues : fleuret, bonnes catégories, bon sexe, bon format', () => {
  assert.ok(C.wanted(entry(), 'Fleuret Hommes Senior'));
  assert.ok(C.wanted(entry(), 'Fleuret Dames Senior'));
  assert.ok(!C.wanted(entry(), 'Épée Hommes Senior'));
  assert.ok(!C.wanted(entry(), 'Fleuret Hommes M20'));
  assert.ok(!C.wanted(entry(), 'Fleuret Hommes Senior par équipes'));
  assert.ok(!C.wanted(entry({ gender: 'H' }), 'Fleuret Dames Senior'));
  assert.ok(C.wanted(entry({ categories: ['SENIOR', 'V1', 'V2'] }), 'Fleuret Hommes Vétérans V1'));
  assert.ok(C.wanted(entry({ format: 'BOTH' }), 'Fleuret Dames Senior par équipes'));
});

test('tournois candidats : même ville (alias compris) et dates qui se recouvrent', () => {
  const ftl = [
    { id: 'a'.repeat(32), name: 'EN1 Hénin', location: 'Henin-Beaumont, FRA', start: '2026-10-17T00:00:00.000Z' },
    { id: 'b'.repeat(32), name: 'Autre', location: 'Henin-Beaumont, FRA', start: '2026-12-01T00:00:00.000Z' },
  ];
  const engarde = [
    {
      org: 'club',
      ev: 'en1',
      title: 'EN1',
      city: 'HÉNIN-BEAUMONT',
      date_from: '2026-10-17',
      date_to: '2026-10-18',
      ioc_country_code: 'FRA',
    },
  ];
  const found = C.candidates(entry(), { ftl, engarde });
  assert.deepEqual(
    found.map((f) => [f.provider, f.country, f.sourceUrl]),
    [
      ['ftl', 'FRA', `https://www.fencingtimelive.com/tournaments/eventSchedule/${'A'.repeat(32)}`],
      ['engarde', 'FRA', 'https://engarde-service.com/tournament/club/en1'],
    ],
  );
  assert.ok(C.sameCity('Livourne', 'Livorno, ITA'));
  assert.ok(!C.sameCity('Paris', 'Lyon, FRA'));
  assert.ok(!C.sameCity(null, 'Lyon, FRA'));
});

test('surveillance : seules les épreuves voulues sont ajoutées, le lien est noté, les admins prévenus', async () => {
  const logs = [];
  const db = {
    user: { findFirst: async () => ({ id: 1 }), findMany: async () => [] },
    auditLog: {
      findMany: async () => [],
      create: async ({ data }) => (logs.push(data), data),
    },
    competition: { findUnique: async () => null },
    pushSubscription: { findMany: async () => [] },
  };
  let saved;
  const ftlTournament = {
    preview: async (_db, input) => {
      assert.equal(input.timezone, 'Europe/Paris');
      return {
        previewId: 9,
        events: [
          { eventId: 'H', event: 'Fleuret Hommes Senior', existingCompetitionId: null },
          { eventId: 'D', event: 'Fleuret Dames Senior', existingCompetitionId: null },
          { eventId: 'E', event: 'Épée Hommes Senior', existingCompetitionId: null },
        ],
      };
    },
    save: async (_db, input) => {
      saved = input;
      return {
        tournamentId: 42,
        name: 'EN1 Hénin',
        events: input.eventIds.map((id) => ({ name: id, created: true })),
      };
    },
  };
  const result = await C.watch(db, {
    now: Date.parse('2026-10-07T12:00:00Z'),
    ftl: {
      login: async () => {},
      get: async () => [
        { id: 'c'.repeat(32), name: 'EN1 Hénin', location: 'Hénin-Beaumont, FRA', start: '2026-10-17T00:00:00.000Z' },
      ],
    },
    engarde: { get: async () => JSON.stringify({ events: [] }) },
    ftlTournament,
    mailer: { mailConfigured: () => false },
    push: { configured: () => false },
  });
  assert.deepEqual(saved.eventIds, ['H', 'D']);
  assert.equal(result.added[0].tournamentId, 42);
  const link = logs.find((l) => l.action === 'Calendrier : tournoi relié');
  assert.equal(link.after.calendarId, '2026-10-17-henin-beaumont-senior-ind');
  assert.ok(logs.some((l) => l.action === 'Calendrier : surveillance'));
});

test('surveillance : une épreuve illisible n’empêche pas l’ajout des autres', async () => {
  const logs = [];
  const db = {
    user: { findFirst: async () => ({ id: 1 }), findMany: async () => [] },
    auditLog: { findMany: async () => [], create: async ({ data }) => (logs.push(data), data) },
    competition: { findUnique: async () => null },
    pushSubscription: { findMany: async () => [] },
  };
  const ftlTournament = {
    preview: async () => ({
      previewId: 3,
      events: [
        { eventId: 'H', event: 'Senior Men’s Foil', existingCompetitionId: null },
        { eventId: 'D', event: 'Senior Women’s Foil', existingCompetitionId: null },
      ],
    }),
    save: async (_db, { eventIds }) => {
      if (eventIds.includes('D'))
        throw Object.assign(new Error('Identité d’un engagé non vérifiable.'), { status: 409 });
      return { tournamentId: 5, name: 'EN1', events: [{ name: 'Senior Men’s Foil', created: true }] };
    },
  };
  const result = await C.watch(db, {
    now: Date.parse('2026-10-07T12:00:00Z'),
    ftl: {
      login: async () => {},
      get: async () => [
        { id: 'd'.repeat(32), name: 'EN1', location: 'Henin-Beaumont, FRA', start: '2026-10-17T00:00:00.000Z' },
      ],
    },
    engarde: { get: async () => '{"events":[]}' },
    ftlTournament,
    mailer: { mailConfigured: () => false },
    push: { configured: () => false },
  });
  assert.deepEqual(result.added[0].events, ['Senior Men’s Foil']);
  assert.match(result.problems[0], /Senior Women’s Foil : Identité/);
});

test('calendrier public : chaque entrée garde ses propres épreuves et leurs vraies dates', async () => {
  const link = (calendarId) => ({ after: { calendarId, tournamentId: 4 }, createdAt: new Date() });
  const db = {
    auditLog: {
      findMany: async ({ where }) =>
        where.action === 'Calendrier : tournoi relié'
          ? [link('2026-10-10-etampes-m17-ind'), link('2026-10-10-etampes-m20-ind')]
          : [
              { targetId: 1, after: { date: '2026-10-10' } },
              { targetId: 2, after: { date: '2026-10-10' } },
              { targetId: 3, after: { date: '2026-10-11' } },
            ],
    },
    tournament: {
      findMany: async () => [
        {
          id: 4,
          competitions: [
            { id: 1, name: "Cadet Women's Foil" },
            { id: 2, name: "Cadet Men's Foil" },
            { id: 3, name: "Junior Men's Foil" },
          ],
        },
      ],
    },
  };
  const list = await C.upcoming(db, Date.parse('2026-10-07T00:00:00Z'));
  const m17 = list.find((e) => e.id === '2026-10-10-etampes-m17-ind');
  const m20 = list.find((e) => e.id === '2026-10-10-etampes-m20-ind');
  assert.deepEqual([m17.competitionIds, m17.start, m17.end], [[1, 2], '2026-10-10', '2026-10-10']);
  assert.deepEqual([m20.competitionIds, m20.start, m20.end], [[3], '2026-10-11', '2026-10-11']);
  assert.ok(list.indexOf(m17) < list.indexOf(m20));
});
