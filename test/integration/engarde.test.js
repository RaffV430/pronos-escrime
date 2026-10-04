// Parcours complet d'une épreuve engarde-service sur un vrai PostgreSQL et le vrai client Prisma :
// tournoi créé vide, engagés et poules publiés (points de poules), puis tableau et podium officiels.
// Pages réelles du tournoi IDF 1 Fleuret M20 de Mennecy (extraits), servies par un faux client.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');

let skip = url ? false : 'TEST_DATABASE_URL non défini';
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('engarde');
  process.env.JWT_SECRET ||= 'test-integration-secret-at-least-32-characters';
}
let prisma;
if (!skip) {
  try {
    prisma = require('../../src/lib/prisma');
  } catch (e) {
    skip = `Client Prisma indisponible : ${String(e.message).split('\n')[0]}`;
  }
}
const opts = { skip };
before(async () => {
  if (!skip) await freshDatabase('engarde');
});
after(async () => {
  await prisma?.$disconnect();
});

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'engarde', name), 'utf8');
const E = require('../../src/services/engardeParser');
const BASE = '/competition/life/idf1fm20mennecy/fdm20/';

// Engagés : tous les tireurs des poules 1-2 et du tableau de 16, avec leur club.
function rosterHtml() {
  const clubs = new Map();
  for (const p of E.parsePools(fixture('fdm20-poules-1-2.html'))) for (const r of p.rows) clubs.set(r.name, r.club);
  for (const m of E.parseTableaus([fixture('fdm20-tableau16.html')]).matches) {
    clubs.set(m.player1, m.club1);
    clubs.set(m.player2, m.club2);
  }
  const rows = [...clubs].map(([name, club], i) => {
    const words = name.split(' ');
    const k = words.findIndex((w) => w !== w.toUpperCase());
    return `<tr><td>${i + 1}</td><td>100${i}</td><td>${words.slice(0, k).join(' ')}</td><td>${words.slice(k).join(' ')}</td><td><span class="club">${club}</span></td></tr>`;
  });
  return {
    size: clubs.size,
    html: `<table class="liste"><tr><th>R.i.</th><th>Série</th><th>Nom</th><th>Prénom</th><th>Club</th></tr>${rows.join('')}</table>`,
  };
}
// Poules publiées avant leur début : mêmes compositions, aucune case remplie.
const emptyPools = () =>
  fixture('fdm20-poules-1-2.html').replace(
    /<td class="(H?G?B?D|HBD|HGBD|GBD|BD)">(?:<div class="victory-cell">[^<]*<\/div>|\d*)<\/td>/g,
    '<td class="$1"></td>',
  );
const finalRanking = `<table><tr><th>RG</th><th>NOM</th><th>PRÉNOM</th><th>CLUB</th></tr>
<tr><td>1</td><td>LI</td><td>HELENE ZHIXUAN</td><td>ANTONY</td></tr>
<tr><td>2</td><td>BOLORE</td><td>MÉLISANDE</td><td>ANTONY</td></tr>
<tr><td>3</td><td>FRIHA YAHIAOUI</td><td>SHERINE</td><td>ANTONY</td></tr>
<tr><td>3</td><td>ADAMO</td><td>ANITA</td><td>BLR92</td></tr></table>`;

test('engarde-service : tournoi créé vide, puis engagés, poules, tableau et podium importés', opts, async () => {
  const roster = rosterHtml();
  const stage = { published: [] };
  const menu = (compe, files) =>
    `<ul>${['/tournament/life/idf1fm20mennecy', ...files.map((f) => `/competition/life/idf1fm20mennecy/${compe}/${f}`)]
      .map((h) => `<li><a class="link-competition" href="${h}">x</a></li>`)
      .join('')}</ul>`;
  const client = {
    competitions: async () => fixture('tournament-idf1fm20mennecy.xml'),
    get: async (u) => {
      const p = new URL(u, 'https://engarde-service.com').pathname;
      if (p === BASE.slice(0, -1)) return menu('fdm20', stage.published);
      if (p === '/competition/life/idf1fm20mennecy/fhm20') return menu('fhm20', []);
      const file = p.slice(BASE.length);
      if (!stage.published.includes(file)) throw Object.assign(new Error('absent'), { status: 404 });
      return {
        'tireurs.htm': roster.html,
        'poules1.htm': stage.pools,
        'poules2.htm': stage.pools2,
        'tableau16.htm': fixture('fdm20-tableau16.html'),
        // Le classement officiel écrit les prénoms en capitales : comparaison sans tenir compte de la casse.
        'clasfinal.htm': finalRanking,
      }[file];
    },
  };
  const admin = await prisma.user.create({
    data: { email: `admin-${Date.now()}@exemple.test`, password: 'x', name: 'Admin engarde', isAdmin: true },
  });
  const { preview, save } = require('../../src/services/engardeTournament');
  const { syncCompetition } = require('../../src/services/ftlSync');

  // 1. Création du tournoi alors que l'épreuve est encore vide.
  const seen = await preview(
    prisma,
    { sourceUrl: 'https://engarde-service.com/tournament/life/idf1fm20mennecy' },
    admin.id,
    client,
  );
  assert.equal(seen.timezone, 'Europe/Paris');
  assert.equal(seen.events.length, 2);
  const saved = await save(
    prisma,
    { previewId: seen.previewId, eventIds: ['life/idf1fm20mennecy/fdm20'] },
    admin.id,
    client,
  );
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].pending, true);
  const id = saved.events[0].competitionId;
  const run = async () => {
    await prisma.ftlSyncState.updateMany({ where: { competitionId: id }, data: { lastStartedAt: null } });
    return syncCompetition(prisma, id, admin.id, { engarde: client });
  };

  let summary = await run();
  assert.match(summary.notes.join(' '), /pas encore publiée/);
  assert.equal((await prisma.competition.findUnique({ where: { id } })).podiumRoster, null);

  // 2. Engagés et poules publiés, pas encore commencées : un joueur pronostique BOLORE (6 V, +21).
  stage.published = ['tireurs.htm', 'formule.htm', 'poules1.htm'];
  stage.pools = emptyPools();
  summary = await run();
  let c = await prisma.competition.findUnique({ where: { id } });
  assert.equal(c.podiumRoster.length, roster.size);
  assert.match(c.rosterSourceUrl, /\/fdm20\/tireurs\.htm$/);
  const pools = await prisma.pool.findMany({ where: { competitionId: id }, include: { fencers: true } });
  assert.equal(pools.length, 2);
  assert.equal(pools.flatMap((p) => p.fencers).length, 13);
  const bolore = pools.flatMap((p) => p.fencers).find((f) => f.name === 'BOLORE Mélisande');
  assert.equal(bolore.wins, null);
  const player = await prisma.user.create({
    data: { email: `joueur-${Date.now()}@exemple.test`, password: 'x', name: 'Joueur engarde' },
  });
  await prisma.poolPrediction.create({
    data: { userId: player.id, fencerId: bolore.id, wins: 6, losses: 0, indicator: 21, savedAt: new Date() },
  });

  // 3. Poules terminées : bilans officiels et points de poule.
  stage.pools = fixture('fdm20-poules-1-2.html');
  summary = await run();
  assert.equal(summary.pools.checked, 2);
  const done = await prisma.poolFencer.findUnique({ where: { id: bolore.id } });
  assert.deepEqual([done.wins, done.losses, done.indicator], [6, 0, 21]);
  const pp = await prisma.poolPrediction.findFirst({ where: { userId: player.id } });
  assert.ok(pp.pointsEarned > 0, 'pronostic exact récompensé');

  // 3 bis. Second tour de poules publié (mêmes tireuses, plus tard dans la journée) : poules distinctes.
  stage.published.push('poules2.htm');
  stage.pools2 = fixture('fdm20-poules-1-2.html').replace(/12:30/g, '14:00');
  summary = await run();
  const round2 = await prisma.pool.findMany({ where: { competitionId: id, sourceUrl: { endsWith: '/poules2.htm' } } });
  assert.deepEqual(round2.map((p) => p.name).sort(), ['Tour 2 · Poule 1', 'Tour 2 · Poule 2']);
  assert.equal(round2[0].startsAt.toISOString().slice(0, 10), '2026-09-20', 'même jour : 14 h après 12 h 30');

  // 4. Tableau et classement final publiés : rencontres, horaires (heure de Paris) et podium officiel.
  stage.published.push('tableau16.htm', 'clasfinal.htm');
  summary = await run();
  assert.deepEqual(summary.warnings, []);
  const matches = await prisma.match.findMany({ where: { competitionId: id } });
  assert.equal(matches.length, 15);
  const first = matches.find((m) => m.sourceKey === 'T16:1');
  assert.deepEqual(
    [first.player1, first.player2, first.score1, first.score2],
    ['BOLORE Mélisande', 'GIMARD Ninon', 15, 7],
  );
  assert.equal(first.startsAt.toISOString(), '2026-09-20T13:30:00.000Z');
  assert.equal(first.strip, '9');
  const final = matches.find((m) => m.round === 'T2');
  assert.deepEqual([final.isFinished, final.winner], [true, 2]);
  c = await prisma.competition.findUnique({ where: { id } });
  const li = c.podiumRoster.find((e) => e.name === 'LI Helene Zhixuan');
  assert.equal(c.officialPodium.gold, li.id);
  assert.ok(c.podiumResolvedAt, 'podium résolu');
  assert.equal(await prisma.matchRound.count({ where: { competitionId: id } }), 4);

  // Un nouveau contrôle ne change rien (idempotent).
  summary = await run();
  assert.equal(summary.created, 0);
  assert.equal(summary.results, 0);
});
