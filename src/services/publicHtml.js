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
// Adresses lisibles, identiques à celles de l'application : /tournoi/etampes-cn-m17-m20-4/junior-womens-foil-16.
function slug(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}
const segment = (name, id) => (slug(name) ? `${slug(name)}-${id}` : String(id));
const publicPath = (t, c = null) => `/tournoi/${segment(t.name, t.id)}${c?.id ? `/${segment(c.name, c.id)}` : ''}`;
// « etampes-cn-m17-m20-4 » ou « 4 » → 4.
function idOf(seg) {
  const n = Number(/(?:^|-)(\d+)$/.exec(String(seg || ''))?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
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

// Page d'un tournoi, ou d'une seule de ses épreuves (eventId).
function tournamentPage(data, eventId = null) {
  const event = eventId ? data.competitions.find((c) => c.id === eventId) || null : null;
  const url = `${SITE}${publicPath(data, event)}`;
  const description = event
    ? [
        `${event.name} · ${data.name}`,
        event.podium.length ? `podium : ${event.podium.map((p) => p.name).join(', ')}` : 'tableau, poules et podium',
        shareDates(data.start, data.end),
      ]
        .filter(Boolean)
        .join(' · ')
    : shareText(data, data);
  const where = [data.city, shareDates(data.start, data.end)].filter(Boolean).join(' · ');
  const competitions = (event ? [event] : data.competitions)
    .map(
      (c) =>
        `<section><h2>${event ? esc(c.name) : `<a href="${esc(SITE + publicPath(data, c))}">${esc(c.name)}</a>`}</h2>${
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
<title>${esc(event ? `${event.name} · ${data.name} : résultats · Pronos Escrime` : `${data.name} : résultats et pronostics · Pronos Escrime`)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/svg+xml" href="${SITE}/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pronos Escrime">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(event ? `${event.name} · ${data.name}` : data.name)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Logo Pronos Escrime : un fleuret qui forme la lettre P">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${json(structuredData(event ? { ...data, name: `${event.name} · ${data.name}`, competitions: [event] } : data, url, description))}</script>
</head><body>
<header><a href="${SITE}/">Pronos Escrime</a></header>
<main>
<h1>${esc(event ? event.name : data.name)}</h1>
${event ? `<p><a href="${esc(SITE + publicPath(data))}">${esc(data.name)}</a></p>` : ''}
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
    ...tournaments.flatMap((t) => [
      { loc: `${SITE}${publicPath(t)}`, lastmod: day(t.updatedAt), priority: '0.8' },
      // Une page par épreuve (résultats « fleuret dames M17 Étampes »).
      ...(t.competitions || []).map((c) => ({
        loc: `${SITE}${publicPath(t, c)}`,
        lastmod: day(t.updatedAt),
        priority: '0.7',
      })),
    ]),
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

module.exports = { tournamentPage, sitemap, structuredData, SITE, slug, segment, publicPath, idOf };
