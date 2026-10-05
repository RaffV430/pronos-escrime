// Banc d'essai « pires scénarios » engarde-service : une épreuve fictive servie par un faux site,
// dont on modifie les pages entre deux contrôles (site en panne, tirage refait, score corrigé…).
const fs = require('node:fs');
const path = require('node:path');
const E = require('../../src/services/engardeParser');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'engarde', name), 'utf8');
const ROUND_TITLES = { 2: 'Finale', 4: 'Demi-finales', 8: 'Tableau de 8' };
const titleOf = (n) => ROUND_TITLES[n] || `Tableau de ${n}`;

// Tableau engarde (même grille que le site) : `entrants` dans l'ordre du tableau, `results[r][k]` pour le
// match k du tour r : { w: 1|2, score: '15/7' } (score vide = avancement sans score, 'DNF' = abandon),
// absent = pas encore joué. Le vainqueur d'un tour alimente le tour suivant.
function tableauHtml(entrants, results = [], { times = [], start = '15:30' } = {}) {
  const n = entrants.length;
  const rounds = Math.log2(n);
  const rows = 2 * n + 2;
  const cols = 3 + rounds + 1;
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
  const col = (r) => (r === 0 ? 1 : 2 + r);
  for (let r = 0; r < rounds; r++) grid[0][col(r)] = `<td class="tableTitle"> ${titleOf(n >> r)}</td>`;
  let row = entrants.map((_, i) => 1 + 2 * i);
  let names = entrants.map((e) => e.name);
  entrants.forEach((e, i) => {
    grid[row[i]][0] = `<td class="D placeNumber">${e.seed ?? i + 1}</td>`;
    grid[row[i]][1] = `<td class="HBD fencer"> ${e.name} </td>`;
    grid[row[i]][2] = `<td class="HBD nation"><span class="club">${e.club}</span></td>`;
  });
  for (let r = 0; r < rounds; r++) {
    const nextRow = [],
      nextNames = [];
    for (let k = 0; k < names.length / 2; k++) {
      const [a, b] = [row[2 * k], row[2 * k + 1]];
      const mid = Math.floor((a + b) / 2);
      nextRow.push(mid);
      const time = times[r]?.[k] ?? start;
      grid[mid][col(r)] = `<td class="timePiste"><small><i>${time} Piste ${k + 1}</i></small></td>`;
      const res = results[r]?.[k];
      const winner = res ? names[2 * k + res.w - 1] : '';
      nextNames.push(winner);
      // Case du tour suivant toujours présente (vide tant que le match n'est pas joué), comme sur le site.
      grid[mid][col(r + 1)] = `<td class="HBD fencer"> ${winner} </td>`;
      if (res) grid[mid + 1][col(r + 1)] = `<td class="D score">${res.score}</td>`;
    }
    row = nextRow;
    names = nextNames;
  }
  const body = grid.map((cells) => `<tr>${cells.map((c) => c || '<td></td>').join('')}</tr>`).join('');
  return `<div id="reloadable"><h3>${titleOf(n)}</h3><table class="tableau" summary="${titleOf(n)}"><tbody>${body}</tbody></table></div>`;
}

// Tous les tours joués, vainqueur = tireur 1 sauf indication contraire.
function fullResults(n, override = {}) {
  const out = [];
  for (let r = 0, m = n / 2; m >= 1; r++, m /= 2)
    out.push(Array.from({ length: m }, (_, k) => override[`${r}:${k}`] || { w: 1, score: '15/10' }));
  return out;
}

// Engagés (liste « tireurs.htm ») : NOM Prénom, club.
function rosterHtml(entries, { checkedIn = true } = {}) {
  const rows = entries.map((e, i) => {
    const words = e.name.split(' ');
    const k = words.findIndex((w) => w !== w.toUpperCase());
    return `<tr><td>${i + 1}</td><td>100${i}</td><td>${words.slice(0, k).join(' ')}</td><td>${words.slice(k).join(' ')}</td><td><span class="club">${e.club}</span></td></tr>`;
  });
  const title = checkedIn ? `Tireurs (présents - ${entries.length})` : 'Tireurs';
  return `<h3>${title}</h3><table class="liste" summary="${title}"><tr><th>R.i.</th><th>Série</th><th>Nom</th><th>Prénom</th><th>Club</th></tr>${rows.join('')}</table>`;
}

// Engagés des poules réelles de Mennecy (2 poules, 13 tireuses) et du tableau de 16.
function mennecyEntries() {
  const clubs = new Map();
  for (const p of E.parsePools(fixture('fdm20-poules-1-2.html'))) for (const r of p.rows) clubs.set(r.name, r.club);
  for (const m of E.parseTableaus([fixture('fdm20-tableau16.html')]).matches) {
    clubs.set(m.player1, m.club1);
    clubs.set(m.player2, m.club2);
  }
  return [...clubs].map(([name, club]) => ({ name, club }));
}
const emptyPools = (html = fixture('fdm20-poules-1-2.html')) =>
  html.replace(
    /<td class="(H?G?B?D|HBD|HGBD|GBD|BD)">(?:<div class="victory-cell">[^<]*<\/div>|\d*)<\/td>/g,
    '<td class="$1"></td>',
  );

let counter = 0;
// Épreuve fictive : tournoi, épreuve et configuration engarde, faux site modifiable entre deux contrôles.
async function engardeEvent(prisma, { date = '2026-09-20', time = '12:00', format = 'INDIVIDUAL' } = {}) {
  const slug = `scen${++counter}${Date.now() % 100000}`;
  const BASE = `/competition/life/scenarios/${slug}`;
  const site = { files: {}, down: null, calls: [] };
  const client = {
    get: async (u) => {
      const p = new URL(u, 'https://engarde-service.com').pathname;
      site.calls.push(p);
      if (site.down) throw new E.EngardeError(site.down);
      if (p === BASE)
        return `<ul>${Object.keys(site.files)
          .map((f) => `<li><a class="link-competition" href="${BASE}/${f}">${f}</a></li>`)
          .join('')}</ul>`;
      const value = site.files[p.slice(BASE.length + 1)];
      if (value === undefined) throw new E.EngardeError('engarde-service indisponible (404).');
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value() : value;
    },
  };
  const admin = await prisma.user.create({
    data: { email: `admin-${slug}@exemple.test`, password: 'x', name: `Admin ${slug}`, isAdmin: true },
  });
  const tournament = await prisma.tournament.create({
    data: { name: `Scénario ${slug}`, ftlSourceUrl: `https://engarde-service.com/tournament/life/${slug}` },
  });
  const c = await prisma.competition.create({
    data: {
      name: `Épreuve ${slug}`,
      tournamentId: tournament.id,
      podiumFormat: format,
      ftlEventId: `ENGARDE:life/scenarios/${slug}`,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: admin.id,
      action: 'Configuration FTL validée',
      targetType: 'Competition',
      targetId: c.id,
      after: {
        provider: 'engarde',
        org: 'life',
        tournamentSlug: 'scenarios',
        compe: slug,
        eventId: `life/scenarios/${slug}`,
        eventSourceUrl: `https://engarde-service.com${BASE}`,
        tournament: tournament.name,
        event: c.name,
        date,
        time,
        timezone: 'Europe/Paris',
        format,
        name: c.name,
      },
    },
  });
  const { syncCompetition } = require('../../src/services/ftlSync');
  const run = async () => {
    await prisma.ftlSyncState.updateMany({ where: { competitionId: c.id }, data: { lastStartedAt: null } });
    return syncCompetition(prisma, c.id, admin.id, { engarde: client });
  };
  // Contrôle qui peut échouer proprement : renvoie { error } au lieu de lever.
  const attempt = async () => {
    try {
      return await run();
    } catch (error) {
      return { error };
    }
  };
  let players = 0;
  const player = async (name = 'Joueur') => {
    const unique = `${name} ${slug}-${++players}`;
    return prisma.user.create({
      data: { email: `${unique.replace(/\W+/g, '-')}@exemple.test`, password: 'x', name: unique },
    });
  };
  return { id: c.id, tournamentId: tournament.id, admin, site, client, run, attempt, player };
}

module.exports = { tableauHtml, fullResults, rosterHtml, mennecyEntries, emptyPools, engardeEvent, fixture };
