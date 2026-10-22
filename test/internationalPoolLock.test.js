const test = require('node:test');
const assert = require('node:assert/strict');
const { syncPools } = require('../src/services/ftlSync');
const rules = require('../src/services/poolRules');
const eventId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const source = `https://www.fencingtimelive.com/pools/scores/${eventId}/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;

for (const [timezone, expected] of [
  ['Africa/Tunis', '2026-10-22T08:00:00.000Z'],
  ['Asia/Tokyo', '2026-10-22T00:00:00.000Z'],
  ['Europe/Paris', '2026-10-22T07:00:00.000Z'],
]) {
  test(`FTL: poule sans résultat fermée à 09:00 locale (${timezone}), choix et points conservés`, async () => {
    const config = {
      tournament: 'Synthetic Open',
      event: 'Synthetic Foil',
      eventTime: 'Thursday, October 22, 2026 9:00 AM',
      date: '2026-10-22',
      timezone,
      poolSources: [source],
    };
    const fencers = [
      { id: 1, name: 'Synthetic A', position: 1 },
      { id: 2, name: 'Synthetic B', position: 2 },
    ];
    const pool = {
      id: 1,
      competitionId: 1,
      name: 'Poule 1',
      sourceUrl: source,
      sourcePoolNumber: 1,
      lockMode: 'FIRST_RESULT',
      isFinal: false,
      isLocked: false,
      closesAt: new Date(0),
      fencers,
    };
    const predictions = [{ id: 7, fencerId: 1, wins: 1, losses: 0, pointsEarned: 8 }];
    const before = structuredClone(predictions);
    const db = {
      pool: {
        findMany: async () => [pool],
        findUnique: async () => pool,
        update: async ({ data }) => Object.assign(pool, data),
      },
      $queryRaw: async () => [],
      poolFencer: { updateMany: async () => ({ count: 0 }) },
      poolPrediction: {
        updateMany: async () => {
          throw new Error('Points must not change');
        },
      },
    };
    db.$transaction = async (fn) => fn(db);
    const c = {
      id: 1,
      rosterSourceUrl: `https://www.fencingtimelive.com/events/competitors/${eventId}`,
      podiumRoster: fencers.map((f) => ({ id: String(f.id), name: f.name })),
    };
    const page = (time) =>
      `<span class="desktop tournName">${config.tournament}</span><span class="desktop eventName">${config.event}</span><span class="desktop eventTime">${config.eventTime}</span><a href="${source}">Pools</a><div><h4 class="poolNum">Pool #1</h4><span class="poolStripTime">On strip 1 at ${time}</span><table class="poolTable"><thead><tr class="poolHeader"><th></th><th></th><th>1</th><th>2</th></tr></thead><tbody>${fencers.map((f, i) => `<tr class="poolRow"><td><span class="poolCompName">${f.name}</span></td><td class="poolPos">${i + 1}</td><td></td><td></td>${Array.from({ length: 5 }, () => '<td class="poolResult"></td>').join('')}</tr>`).join('')}</tbody></table></div>`;
    let time = '9:00 AM';
    const client = { get: async () => page(time) };
    const result = await syncPools(db, c, config, null, client);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.checked, 1);
    assert.equal(pool.lockMode, rules.START_LOCK);
    assert.equal(pool.closesAt.toISOString(), expected);
    assert.equal(rules.closed(pool, new Date(Date.parse(expected) - 1)), false);
    assert.equal(rules.closed(pool, new Date(expected)), true);
    assert.equal(
      rules.fencerClosed(
        pool,
        { ...fencers[0], firstResultAt: new Date(Date.parse(expected) - 10000) },
        new Date(Date.parse(expected) - 5000),
      ),
      true,
    );
    time = '10:00 AM';
    assert.deepEqual((await syncPools(db, c, config, null, client)).warnings, []);
    assert.equal(pool.closesAt.getTime(), Date.parse(expected) + 3600000);
    assert.deepEqual(predictions, before);
    assert.deepEqual(pool.fencers, fencers);
  });
}
