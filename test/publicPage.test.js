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

test('page pour les robots : titre, podiums, classement, données structurées, texte échappé', () => {
  const { tournamentPage, sitemap } = require('../src/services/publicHtml');
  const html = tournamentPage({
    id: 4,
    name: 'Circuit <Antony>',
    start: '2026-10-04',
    end: '2026-10-04',
    city: 'Antony',
    countries: ['FR'],
    competitions: [
      { name: 'Fleuret hommes', podium: [{ place: 1, name: 'DOE John', country: 'FRA' }] },
      { name: 'Fleuret dames', podium: [] },
    ],
    leaderboard: [{ rank: 1, name: 'Theo', points: 70 }],
  });
  assert.match(html, /<h1>Circuit &lt;Antony&gt;<\/h1>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www.pronos-escrime.fr\/tournoi\/circuit-antony-4">/);
  assert.match(html, /Or : DOE John \(FRA\)/);
  assert.match(html, /Podium pas encore publié/);
  assert.match(html, /1\. Theo — 70 pts/);
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(ld['@type'], 'SportsEvent');
  assert.equal(ld.startDate, '2026-10-04');
  assert.equal(ld.location.address.addressCountry, 'FR');
  assert.ok(!html.includes('<Antony>'));
  const xml = sitemap(
    [
      {
        id: 4,
        name: 'Circuit Antony',
        updatedAt: '2026-10-04',
        competitions: [{ id: 11, name: 'Fleuret Hommes senior' }],
      },
    ],
    new Date('2026-10-06T00:00:00Z'),
  );
  assert.match(
    xml,
    /<loc>https:\/\/www.pronos-escrime.fr\/tournoi\/circuit-antony-4<\/loc><lastmod>2026-10-04<\/lastmod>/,
  );
  assert.match(xml, /<loc>https:\/\/www.pronos-escrime.fr\/tournoi\/circuit-antony-4\/fleuret-hommes-senior-11<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www.pronos-escrime.fr\/<\/loc><lastmod>2026-10-06<\/lastmod>/);
});

test('page robots d’une seule épreuve : titre, adresse et lien vers le tournoi', () => {
  const { tournamentPage, idOf } = require('../src/services/publicHtml');
  const data = {
    id: 4,
    name: 'Etampes CN M17/M20',
    start: '2026-10-10',
    end: '2026-10-11',
    city: 'Étampes',
    countries: ['FR'],
    competitions: [
      { id: 13, name: "Cadet Women's Foil", podium: [] },
      { id: 16, name: "Junior Women's Foil", podium: [{ place: 1, name: 'SOUMAGNE Perle', country: '' }] },
    ],
    leaderboard: [],
  };
  const html = tournamentPage(data, 16);
  assert.match(html, /<h1>Junior Women&#39;s Foil<\/h1>/);
  assert.match(html, /tournoi\/etampes-cn-m17-m20-4\/junior-womens-foil-16/);
  assert.ok(!html.includes('Cadet Women'));
  assert.equal(idOf('etampes-cn-m17-m20-4'), 4);
  assert.equal(idOf('nom-sans-numero'), null);
});
