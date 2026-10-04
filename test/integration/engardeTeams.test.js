// Épreuve par équipes engarde-service sur un vrai PostgreSQL : liste des équipes, tableau principal,
// match pour la 3e place et podium officiel (un seul bronze). Pages réelles d'Aix (15/03/2026).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');

let skip = url ? false : 'TEST_DATABASE_URL non défini';
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('engarde_teams');
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
  if (!skip) await freshDatabase('engarde_teams');
});
after(async () => {
  await prisma?.$disconnect();
});

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'engarde', name), 'utf8');
const E = require('../../src/services/engardeParser');
const BASE = '/competition/epa/aixnational/fdm20equipe';

// Liste des équipes reconstituée depuis la colonne d'entrée du tableau (même forme que equipes.htm).
function teamsHtml() {
  const clubs = new Map();
  for (const m of E.parseTableaus([fixture('equipes-fdm20-tableau16.html')]).matches.filter((m) => m.round === 'T16')) {
    clubs.set(m.player1, m.club1);
    clubs.set(m.player2, m.club2);
  }
  const rows = [...clubs].map(
    ([name, club], i) =>
      `<tr><td>${i + 1}</td><td>(1 2 3)</td><td>${name}<br>&nbsp;&nbsp;TIREUSE Une<br>&nbsp;&nbsp;TIREUSE Deux</td><td><div class="club-container"><span>${club}</span></div></td></tr>`,
  );
  return {
    size: clubs.size,
    html: `<h3>Équipes (présentes - ${clubs.size})</h3><table class="liste" summary="Équipes (présentes - ${clubs.size})"><tr><th>R.i.</th><th>No série</th><th>Nom</th><th>Club</th></tr>${rows.join('')}</table>`,
  };
}

test('engarde-service par équipes : équipes, tableau, 3e place et podium importés', opts, async () => {
  const teams = teamsHtml();
  const published = ['equipes.htm', 'tableau16.htm', 'clasfinal.htm'];
  const client = {
    get: async (u) => {
      const p = new URL(u, 'https://engarde-service.com').pathname;
      if (p === BASE)
        return `<ul>${published.map((f) => `<li><a class="link-competition" href="${BASE}/${f}">x</a></li>`).join('')}</ul>`;
      return {
        [`${BASE}/equipes.htm`]: teams.html,
        [`${BASE}/tableau16.htm`]: fixture('equipes-fdm20-tableau16.html'),
        [`${BASE}/clasfinal.htm`]: fixture('equipes-fdm20-clasfinal.html'),
      }[p];
    },
  };
  const admin = await prisma.user.create({
    data: { email: `admin-${Date.now()}@exemple.test`, password: 'x', name: 'Admin équipes', isAdmin: true },
  });
  const tournament = await prisma.tournament.create({
    data: { name: 'Demi-finale CDF équipes', ftlSourceUrl: 'https://engarde-service.com/tournament/epa/aixnational' },
  });
  const c = await prisma.competition.create({
    data: {
      name: 'Fleuret Dames M20 par équipes',
      tournamentId: tournament.id,
      podiumFormat: 'TEAM',
      ftlEventId: 'ENGARDE:epa/aixnational/fdm20equipe',
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
        org: 'epa',
        tournamentSlug: 'aixnational',
        compe: 'fdm20equipe',
        eventId: 'epa/aixnational/fdm20equipe',
        eventSourceUrl: `https://engarde-service.com${BASE}`,
        tournament: tournament.name,
        event: c.name,
        date: '2026-03-15',
        time: '08:00',
        timezone: 'Europe/Paris',
        format: 'TEAM',
        name: c.name,
      },
    },
  });
  const { syncCompetition } = require('../../src/services/ftlSync');
  const summary = await syncCompetition(prisma, c.id, admin.id, { engarde: client });
  assert.deepEqual(summary.warnings, []);
  const fresh = await prisma.competition.findUnique({ where: { id: c.id } });
  assert.equal(fresh.podiumRoster.length, teams.size);
  const matches = await prisma.match.findMany({ where: { competitionId: c.id } });
  assert.equal(matches.length, 16);
  const bronze = matches.find((m) => m.round === 'Bronze');
  assert.deepEqual([bronze.player2, bronze.winner, bronze.isFinished], ['LYON MDF 1', 2, true]);
  assert.equal(await prisma.matchRound.count({ where: { competitionId: c.id } }), 5);
  const byId = (id) => fresh.podiumRoster.find((e) => e.id === id)?.name;
  assert.deepEqual([fresh.officialPodium.gold, fresh.officialPodium.silver, fresh.officialPodium.bronze1].map(byId), [
    'ANTONY 1',
    'PARIS CEP 2',
    'LYON MDF 1',
  ]);
  assert.ok(fresh.podiumResolvedAt, 'podium résolu');
});
