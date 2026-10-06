// Pages HTML rendues pour les robots (moteurs de recherche, aperçus de liens) : même contenu que la page
// publique du tournoi dans l'application, lisible sans JavaScript, avec données structurées schema.org.
const { shareText, shareDates } = require('./eventResults');

const SITE = 'https://www.pronos-escrime.fr';
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
const MEDAL = { 1: 'Or', 2: 'Argent', 3: 'Bronze' };
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

function structuredData(data, url, description) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: data.name,
    sport: 'Escrime',
    url,
    description,
    ...(data.start ? { startDate: data.start } : {}),
    ...(data.end ? { endDate: data.end } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    ...(data.city || data.countries?.length
      ? {
          location: {
            '@type': 'Place',
            name: data.city || data.countries[0],
            address: {
              '@type': 'PostalAddress',
              ...(data.city ? { addressLocality: data.city } : {}),
              ...(data.countries?.[0] ? { addressCountry: data.countries[0] } : {}),
            },
          },
        }
      : {}),
    image: `${SITE}/og-image.png`,
    subEvent: data.competitions.map((c) => ({ '@type': 'SportsEvent', name: c.name, sport: 'Escrime' })),
  };
}

function tournamentPage(data) {
  const url = `${SITE}/tournoi/${data.id}`;
  const description = shareText(data, data);
  const where = [data.city, shareDates(data.start, data.end)].filter(Boolean).join(' · ');
  const competitions = data.competitions
    .map(
      (c) =>
        `<section><h2>${esc(c.name)}</h2>${
          c.podium.length
            ? `<ol>${c.podium
                .map((p) => `<li>${MEDAL[p.place]} : ${esc(p.name)}${p.country ? ` (${esc(p.country)})` : ''}</li>`)
                .join('')}</ol>`
            : '<p>Podium pas encore publié.</p>'
        }</section>`,
    )
    .join('\n');
  const leaderboard = data.leaderboard.length
    ? `<section><h2>Classement des pronostiqueurs</h2><ol>${data.leaderboard
        .map((r) => `<li>${r.rank}. ${esc(r.name)} — ${r.points} pts</li>`)
        .join('')}</ol></section>`
    : '';
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`${data.name} : résultats et pronostics · Pronos Escrime`)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/svg+xml" href="${SITE}/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pronos Escrime">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(data.name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Logo Pronos Escrime : un fleuret qui forme la lettre P">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${json(structuredData(data, url, description))}</script>
</head><body>
<header><a href="${SITE}/">Pronos Escrime</a></header>
<main>
<h1>${esc(data.name)}</h1>
${where ? `<p>${esc(where)}</p>` : ''}
${competitions}
${leaderboard}
<p><a href="${SITE}/">Pronostiquez les prochaines compétitions d’escrime sur Pronos Escrime</a></p>
</main>
<footer><a href="${SITE}/confidentialite">Confidentialité</a> · <a href="${SITE}/mentions-legales">Mentions légales</a></footer>
</body></html>`;
}

function sitemap(tournaments, now = new Date()) {
  const day = (d) => new Date(d || now).toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, lastmod: day(now), priority: '1.0' },
    { loc: `${SITE}/resultats`, lastmod: day(now), priority: '0.9' },
    { loc: `${SITE}/calendrier`, lastmod: day(now), priority: '0.8' },
    ...tournaments.map((t) => ({ loc: `${SITE}/tournoi/${t.id}`, lastmod: day(t.updatedAt), priority: '0.8' })),
    { loc: `${SITE}/confidentialite`, priority: '0.2' },
    { loc: `${SITE}/mentions-legales`, priority: '0.2' },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`,
  )
  .join('\n')}
</urlset>
`;
}

module.exports = { tournamentPage, sitemap, structuredData, SITE };
