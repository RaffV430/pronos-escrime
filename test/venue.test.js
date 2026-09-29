const test = require('node:test');
const assert = require('node:assert');
const { searchCities, toCandidates, utcOffset, offsetLabel, cleanCity } = require('../src/services/venue');
const { eventStart } = require('../src/services/eventStart');

const summer = Date.parse('2026-09-29T12:00:00Z');

test('city search returns the venue timezone with its current UTC offset', async () => {
  const calls = [];
  const http = {
    get: async (url, options) => {
      calls.push({ url, options });
      return {
        data: {
          results: [
            {
              name: 'Budapest',
              admin1: 'Budapest',
              country: 'Hongrie',
              country_code: 'HU',
              timezone: 'Europe/Budapest',
            },
            {
              name: 'Budapest',
              admin1: 'Georgia',
              country: 'États-Unis',
              country_code: 'US',
              timezone: 'America/New_York',
            },
            { name: 'Nowhere', country: 'X', timezone: 'Not/AZone' },
          ],
        },
      };
    },
  };
  const found = await searchCities('  Budapest ', { http, at: summer });
  assert.equal(calls[0].options.params.name, 'Budapest');
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], {
    name: 'Budapest',
    region: null,
    country: 'Hongrie',
    countryCode: 'HU',
    timezone: 'Europe/Budapest',
    offset: 'UTC+2',
    label: 'Budapest, Hongrie',
  });
  assert.equal(found[1].region, 'Georgia');
  assert.equal(found[1].offset, 'UTC-4');
});

test('city search ignores too-short queries and reports an unavailable service', async () => {
  assert.deepEqual(await searchCities('B', { http: { get: () => assert.fail('no call') } }), []);
  await assert.rejects(
    searchCities('Budapest', {
      http: {
        get: async () => {
          throw new Error('network');
        },
      },
    }),
    (e) => e.status === 502,
  );
});

test('offsets follow daylight saving and half-hour zones', () => {
  assert.equal(offsetLabel(utcOffset('Europe/Budapest', summer)), 'UTC+2');
  assert.equal(offsetLabel(utcOffset('Europe/Budapest', Date.parse('2026-12-01T12:00:00Z'))), 'UTC+1');
  assert.equal(offsetLabel(utcOffset('Europe/Istanbul', summer)), 'UTC+3');
  assert.equal(offsetLabel(utcOffset('Asia/Kolkata', summer)), 'UTC+5:30');
  assert.equal(toCandidates(null).length, 0);
});

test('a Budapest venue places a 6:15 PM final at 16:15 UTC (the CISM 2026 regression)', () => {
  const start = eventStart({ date: '2026-09-29', time: '6:15 PM', timezone: 'Europe/Budapest' });
  assert.equal(new Date(start).toISOString(), '2026-09-29T16:15:00.000Z');
});

test('city labels are trimmed and bounded', () => {
  assert.equal(cleanCity('  Budapest,   Hongrie '), 'Budapest, Hongrie');
  assert.equal(cleanCity(''), null);
  assert.throws(
    () => cleanCity('x'.repeat(121)),
    (e) => e.status === 400,
  );
});
