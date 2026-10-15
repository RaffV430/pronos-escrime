// Maquette uniquement : scénarios en mémoire, sans base, FTL, e-mail ou push.
module.exports = async function calendarChecks() {
  const C = require('./calendarWatch');
  const cities = [
    ['Bâle', 'Basel'],
    ['Thessalonique', 'Thessaloniki'],
    ['Luxembourg', 'Luxemburg'],
  ].map(([calendar, official]) => ({ calendar, official, matched: C.sameCity(calendar, official) }));
  const logs = [],
    imported = new Map();
  let late = false;
  const db = {
    user: { findFirst: async () => ({ id: 1 }), findMany: async () => [] },
    auditLog: {
      findMany: async () => logs.map((x) => ({ ...x, createdAt: new Date() })),
      create: async ({ data }) => (logs.push(data), data),
    },
    competition: { findUnique: async () => ({ tournamentId: 1 }) },
    pushSubscription: { findMany: async () => [] },
  };
  const deps = {
    now: Date.parse('2026-10-15T12:00Z'),
    ftl: {
      login: async () => {},
      get: async () => [{ id: 'c'.repeat(32), name: 'SYNTH RODEZ', location: 'Rodez, FRA', start: '2026-10-17' }],
    },
    engarde: {
      get: async () =>
        JSON.stringify({
          events: [{ org: 'synthetic', ev: 'rodez', city: 'Rodez', date_from: '2026-10-17', date_to: '2026-10-18' }],
        }),
    },
    ftlTournament: {
      preview: async () => ({
        previewId: 1,
        events: [
          { eventId: 'H', event: 'Senior Men’s Epee', existingCompetitionId: imported.get('H')?.id || null },
          ...(late
            ? [{ eventId: 'D', event: 'Senior Women’s Epee', existingCompetitionId: imported.get('D')?.id || null }]
            : []),
        ],
      }),
      save: async (_db, { eventIds }) => {
        for (const id of eventIds) if (!imported.has(id)) imported.set(id, { id: imported.size + 1 });
        return { tournamentId: 1, name: 'SYNTH RODEZ', events: eventIds.map((name) => ({ name, created: true })) };
      },
    },
    mailer: { mailConfigured: () => false },
    push: { configured: () => false },
  };
  await C.watch(db, deps);
  const firstCount = imported.size,
    firstId = imported.get('H').id;
  late = true;
  const second = await C.watch(db, { ...deps, now: deps.now + 3 * 3600000 });
  await C.watch(db, { ...deps, now: deps.now + 6 * 3600000 });
  return {
    synthetic: true,
    cities,
    late: {
      before: firstCount,
      after: imported.size,
      firstIdPreserved: firstId === imported.get('H').id,
      delay: 'Passage suivant (3 heures)',
    },
    platforms: {
      tournaments: 1,
      competitions: imported.size,
      warning: second.problems.find((p) => p.includes('autre publication')) || null,
    },
    unchangedAfterThird: imported.size === 2,
  };
};
