const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { nextDay } = require('../src/services/engardeSync');
const { mergeRoster } = require('../src/services/engardeRoster');
const { engardeTournamentFinished, eventComplete } = require('../src/services/tournamentArchive');

test('equal Engarde times stay on the same date; earlier times retain multi-day rollover', () => {
  assert.deepEqual(nextDay({ min: 540, offset: 1 }, 540), { min: 540, offset: 1 });
  assert.equal(nextDay({ min: 600, offset: 1 }, 540).offset, 2);
});
test('contradictory roster identity requires admin confirmation, leaving existing IDs intact', () => {
  const old = [{ id: 'old', name: 'MARTIN Alex', country: 'FRA' }];
  assert.throws(() => mergeRoster(old, [{ id: 'new', name: 'MARTIN Alex', country: 'ITA' }]), /administrateur/);
  assert.equal(old[0].country, 'FRA');
  assert.equal(mergeRoster(old, [{ id: 'new', name: 'MARTIN Alex', country: 'FRA' }]).merged[0].id, 'old');
});
test('Engarde archive checks ALL official events, including those not imported, and final classifications', async () => {
  const E = require('../src/services/engardeParser');
  const xml = fs.readFileSync(__dirname + '/fixtures/engarde/tournament-idf1fm20mennecy.xml', 'utf8');
  const events = E.parseCompetitions(xml, { org: 'life', event: 'idf1fm20mennecy' });
  const configs = [events[0]];
  const classification =
    '<table><tr><th>Rg</th><th>Nom</th><th>Prénom</th></tr><tr><td>1</td><td>A</td><td>Alex</td></tr><tr><td>2</td><td>B</td><td>Bob</td></tr></table>';
  let source = xml,
    missingFinal = false;
  const client = {
    competitions: async () => source,
    get: async (url) => {
      if (url.endsWith('clasfinal.htm')) return classification;
      const e = events.find((e) => e.eventSourceUrl === url);
      return missingFinal && e.compe === events[1].compe
        ? ''
        : `<a class="link-competition" href="/competition/${e.org}/${e.tournamentSlug}/${e.compe}/clasfinal.htm">Classement général</a>`;
    },
  };
  assert.ok(await engardeTournamentFinished(configs, client));
  source = xml.replace('etat="terminée"', 'etat="en cours"');
  assert.equal(await engardeTournamentFinished(configs, client), false);
  source = xml;
  missingFinal = true;
  assert.equal(await engardeTournamentFinished(configs, client), false);
});
test('pending points prevent archiving even if old scores remain final', () => {
  const c = {
    podiumResolvedAt: new Date(),
    resultsVerifiedAt: new Date(),
    officialPodium: { finalConfirmed: true },
    pools: [],
    matches: [{ round: 'T2', isFinished: true, pointsPending: true }],
    matchRounds: [{ round: 'T2', expectedMatchCount: 1 }],
  };
  assert.equal(eventComplete(c), false);
});

test('a unique name is not sufficient when its published nation or club contradicts the roster', () => {
  const { entryFor } = require('../src/services/engardeRoster');
  const roster = [{ id: 'old', name: 'MARTIN Alex', country: 'FRA' }];
  assert.equal(entryFor(roster, 'MARTIN Alex', 'ITA'), null);
  assert.equal(entryFor(roster, 'MARTIN Alex', 'FRA').id, 'old');
});
