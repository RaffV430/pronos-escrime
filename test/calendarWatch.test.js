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

test('calendrier : 108 rendez-vous validés, Hénin-Beaumont les 17 et 18 octobre', () => {
  const all = C.events();
  assert.equal(all.length, 108);
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

test('calendrier : tournoi préparé hors sélection FFE, sessions exactes et configuration récente', async () => {
  let poolRows = [];
  const db = {
    pool: { findMany: async () => poolRows },
    tournament: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { archivedAt: null });
        return [
          {
            id: 70,
            name: 'TEST CUP',
            competitions: [
              { id: 200, name: "Senior Men's Foil" },
              { id: 201, name: 'Sans date' },
            ],
          },
        ];
      },
    },
    auditLog: {
      findMany: async ({ where }) =>
        where.action === 'Calendrier : tournoi relié'
          ? []
          : [
              { targetId: 200, after: { date: '2026-10-14' } },
              {
                targetId: 200,
                after: {
                  date: '2026-10-15',
                  timezone: 'Asia/Tokyo',
                  format: 'INDIVIDUAL',
                  scheduleSessions: [{ date: '2026-10-15' }, { date: '2026-10-17' }, { date: '2026-10-17' }],
                },
              },
              { targetId: 201, after: { date: 'invalide' } },
            ],
    },
  };
  const list = await C.upcoming(db, Date.parse('2026-10-14T00:00:00Z'));
  const mine = list.filter((e) => e.tournamentId === 70);
  assert.deepEqual(
    mine.map((e) => [e.start, e.end, e.competitionIds, e.weapon, e.categories]),
    [
      ['2026-10-15', '2026-10-15', [200], 'Fleuret', ['SENIOR']],
      ['2026-10-17', '2026-10-17', [200], 'Fleuret', ['SENIOR']],
    ],
  );
  assert.equal(mine[0].predictionView, undefined);
  assert.equal(mine[1].predictionView, 'tableau');
  assert.equal(mine[1].tableauPhase, 'main');
  poolRows = [
    { competitionId: 200, isFinal: true },
    { competitionId: 200, isFinal: false },
  ];
  assert.equal(
    (await C.upcoming(db, Date.parse('2026-10-14'))).find((e) => e.id === mine[0].id).predictionView,
    undefined,
  );
  poolRows[1].isFinal = true;
  const afterPools = (await C.upcoming(db, Date.parse('2026-10-14'))).filter((e) => e.tournamentId === 70);
  assert.equal(afterPools[0].tableauPhase, 'preliminary');
  assert.equal(afterPools[1].tableauPhase, 'main');
  const later = await C.upcoming(db, Date.parse('2026-10-16T00:00:00Z'));
  assert.deepEqual(
    later.filter((e) => e.tournamentId === 70).map((e) => e.start),
    ['2026-10-17'],
  );
});

test('épée et U23 : arme et catégorie strictes, pas de confusion avec juniors/seniors', () => {
  const e = entry({ weapon: 'Épée', categories: ['U23'] });
  assert.ok(C.wanted(e, "U23 Men's Epee"));
  assert.ok(C.wanted(e, "Senior U23 Men's Epee"));
  assert.ok(!C.wanted(e, "Junior Men's Epee"));
  assert.ok(!C.wanted(e, "Senior Men's Epee"));
  assert.ok(!C.wanted(e, "U23 Men's Foil"));
});
test('60 choix conservés, regroupements uniques et dates globales non inventées', () => {
  const all = C.events();
  assert.equal(all.flatMap((e) => e.selectionIds || []).length, 60);
  assert.equal(new Set(all.flatMap((e) => e.selectionIds || [])).size, 60);
  const ankara = all.filter((e) => e.city === 'Ankara');
  assert.equal(ankara.length, 1);
  assert.deepEqual(ankara[0].weapons, ['Fleuret', 'Épée', 'Sabre']);
  assert.equal(ankara[0].format, 'BOTH');
  assert.ok(C.wanted(ankara[0], "Junior Women's Sabre Team"));
  assert.ok(!C.wanted(ankara[0], "Senior Women's Sabre Team"));
  assert.equal(all.find((e) => e.selectionIds?.includes(4)).categories[0], 'U23');
});

test('un championnat lié conserve sa plage globale malgré une seule épreuve datée', async () => {
  const e = C.events().find((e) => e.city === 'Ankara');
  const db = {
    auditLog: {
      findMany: async ({ where }) =>
        where.targetType === 'CalendarEvent'
          ? [{ after: { calendarId: e.id, tournamentId: 77 }, createdAt: new Date() }]
          : [{ targetId: 99, after: { date: '2027-04-04' } }],
    },
    tournament: {
      findMany: async () => [{ id: 77, name: 'Worlds', competitions: [{ id: 99, name: "Junior Women's Epee" }] }],
    },
  };
  const found = (await C.upcoming(db, Date.parse('2027-03-01'))).find((x) => x.id === e.id);
  assert.equal(found.start, '2027-04-01');
  assert.equal(found.end, '2027-04-09');
  assert.deepEqual(found.competitionIds, [99]);
});

test('villes épée : variantes internationales sans rapprochement de villes différentes', () => {
  for (const [a, b] of [
    ['Bâle', 'Basel'],
    ['Bâle', 'Basle'],
    ['Berne', 'Bern'],
    ['Thessalonique', 'Thessaloniki'],
    ['Luxembourg', 'Luxemburg'],
  ])
    assert.ok(C.sameCity(a, b));
  assert.ok(!C.sameCity('Bâle', 'Bern'));
});

test('ajouts tardifs : même source relue au passage suivant, autre plateforme signalée sans sauvegarde', async () => {
  const logs = [],
    calendarId = '2026-10-17-henin-beaumont-senior-ind';
  const ftlUrl = 'https://www.fencingtimelive.com/tournaments/eventSchedule/' + 'E'.repeat(32);
  let saved = [],
    late = false,
    previews = 0;
  const db = {
    user: { findFirst: async () => ({ id: 1 }), findMany: async () => [] },
    auditLog: {
      findMany: async () => logs.map((data) => ({ ...data, createdAt: new Date() })),
      create: async ({ data }) => (logs.push(data), data),
    },
    competition: { findUnique: async () => ({ tournamentId: 7 }) },
    pushSubscription: { findMany: async () => [] },
  };
  const deps = {
    now: Date.parse('2026-10-07T12:00Z'),
    ftl: {
      login: async () => {},
      get: async () => [{ id: 'e'.repeat(32), name: 'EN', location: 'Hénin-Beaumont, FRA', start: '2026-10-17' }],
    },
    engarde: {
      get: async () =>
        JSON.stringify({
          events: [{ org: 'test', ev: 'en', city: 'Henin-Beaumont', date_from: '2026-10-17', date_to: '2026-10-18' }],
        }),
    },
    ftlTournament: {
      preview: async (_db, { sourceUrl }) => {
        previews++;
        assert.equal(sourceUrl, ftlUrl);
        return {
          previewId: 1,
          events: [
            { eventId: 'H', event: 'Senior Men’s Foil', existingCompetitionId: 7 },
            ...(late ? [{ eventId: 'D', event: 'Senior Women’s Foil', existingCompetitionId: null }] : []),
          ],
        };
      },
      save: async (_db, input, _actor, _client, id) => {
        assert.equal(id, calendarId);
        saved.push(...input.eventIds);
        return { tournamentId: 7, name: 'EN', events: input.eventIds.map((name) => ({ name, created: true })) };
      },
    },
    mailer: { mailConfigured: () => false },
    push: { configured: () => false },
  };
  const first = await C.watch(db, deps);
  assert.equal(first.added.length, 0);
  assert.ok(first.problems.some((p) => p.includes('autre publication')));
  late = true;
  const second = await C.watch(db, { ...deps, now: deps.now + 3 * 3600000 });
  assert.deepEqual(saved, ['D']);
  assert.equal(previews, 2);
  assert.equal(second.added[0].tournamentId, 7);
  assert.ok(second.problems.some((p) => p.includes('Source conservée')));
});
