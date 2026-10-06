const { test } = require('node:test');
const assert = require('node:assert/strict');
test('page publique : pseudonymes abrégés, jamais de nom complet', () => {
  const { publicName } = require('../src/services/eventResults');
  assert.equal(publicName('Raffaele Venturi'), 'Raffaele V.');
  assert.equal(publicName('Raff'), 'Raff');
  assert.equal(publicName('  '), 'Joueur');
  assert.equal(publicName('jean de la fontaine'), 'jean D.');
});

test('aperçu de partage : dates et vainqueurs lisibles', () => {
  const { shareDates, shareText } = require('../src/services/eventResults');
  assert.equal(shareDates('2026-09-24', '2026-09-27'), '24–27 sept. 2026');
  assert.equal(shareDates('2026-09-30', '2026-10-02'), '30 sept. – 2 oct. 2026');
  assert.equal(shareDates('2026-10-04', '2026-10-04'), '4 oct. 2026');
  const text = shareText(
    {},
    {
      city: 'Samsun',
      start: '2026-09-24',
      end: '2026-09-27',
      competitions: [
        { name: 'Fleuret juniors dames — 26 septembre 2026', podium: [{ place: 1, name: 'DOE Jane', country: 'FRA' }] },
        { name: 'Fleuret cadets', podium: [] },
      ],
    },
  );
  assert.equal(text, 'Samsun · 24–27 sept. 2026 · Vainqueurs — Fleuret juniors dames : DOE Jane (FRA)');
  assert.match(shareText({}, { competitions: [] }), /Podiums, tableaux/);
});
