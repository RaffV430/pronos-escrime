// Tests d'intégration des chemins critiques sur un vrai PostgreSQL et le vrai client Prisma
// (lancés en CI, ou localement avec TEST_DATABASE_URL et un client Prisma généré).
// Ils travaillent dans une base dédiée (<base>_critique), recréée à chaque exécution :
// database.test.js, lancé en parallèle, recrée le schéma public de la base principale.
// Chaque test crée ses propres données (noms uniques) : aucun ne dépend d'un autre.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');

let skip = url ? false : 'TEST_DATABASE_URL non défini';
if (!skip) {
  // src/lib/prisma lit DATABASE_URL : on le fait pointer sur la base dédiée, pour ce processus seulement.
  process.env.DATABASE_URL = dedicatedUrl('critique');
  process.env.JWT_SECRET ||= 'test-integration-secret-at-least-32-characters';
}
let prisma;
if (!skip) {
  try {
    prisma = require('../../src/lib/prisma');
  } catch (e) {
    skip = `Client Prisma indisponible (prisma generate non exécuté ?) : ${String(e.message).split('\n')[0]}`;
  }
}
const opts = { skip };

const SOURCE = 'https://www.fencingtimelive.com/tableaus/scores/0123456789abcdef0123456789abcdef/test';
let server, base, issueToken;
let seq = 0;
const tag = () => `${process.pid}-${Date.now()}-${++seq}`;

before(async () => {
  if (skip) return;
  await freshDatabase('critique');
  const express = require('express');
  const { createPoolRouter } = require('../../src/routes/poolRoutes');
  ({ issueToken } = require('../../src/services/session'));
  const app = express();
  app.use(express.json());
  app.use('/api/matches', require('../../src/routes/matchRoutes'));
  app.use('/api/pools', createPoolRouter(prisma));
  app.use('/api/auth', require('../../src/routes/authRoutes'));
  app.use('/api/public', require('../../src/routes/publicRoutes'));
  app.use('/api/community', require('../../src/routes/communityRoutes'));
  await new Promise((resolve) => (server = app.listen(0, '127.0.0.1', resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma?.$disconnect();
});

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function createUser({ isAdmin = false } = {}) {
  const t = tag();
  const user = await prisma.user.create({
    data: { email: `it-${t}@exemple.test`, password: 'inutilisé', name: `Joueur ${t}`, isAdmin },
  });
  return { ...user, token: issueToken(user) };
}
async function createCompetition() {
  const tournament = await prisma.tournament.create({ data: { name: `Tournoi ${tag()}` } });
  return prisma.competition.create({ data: { tournamentId: tournament.id, name: `Épreuve ${tag()}` } });
}
// Match d'un tour vérifié (MatchRound, premier tour) : ouvert jusqu'à startsAt.
async function createOpenMatch(competitionId, data = {}) {
  await prisma.matchRound.upsert({
    where: { competitionId_round: { competitionId, round: 'T16' } },
    create: { competitionId, round: 'T16', expectedMatchCount: 8, sourceUrl: SOURCE, verifiedAt: new Date() },
    update: {},
  });
  return prisma.match.create({
    data: {
      competitionId,
      player1: `Tireur A ${tag()}`,
      player2: `Tireur B ${tag()}`,
      round: 'T16',
      startsAt: new Date(Date.now() + 3600000),
      sourceUrl: SOURCE,
      ...data,
    },
  });
}
const predict = (match, user, predictedScore1, predictedScore2) =>
  call('POST', `/api/matches/${match.id}/predict`, user.token, { predictedScore1, predictedScore2 });

test('a) un pronostic de match est accepté avant la clôture et refusé après', opts, async () => {
  const competition = await createCompetition();
  const user = await createUser();
  const match = await createOpenMatch(competition.id);

  const ok = await predict(match, user, 15, 10);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const modified = await predict(match, user, 15, 12);
  assert.equal(modified.status, 200, 'modification possible tant que le match est ouvert');

  // Heure de début passée : le match est clos, le pronostic reste celui enregistré.
  await prisma.match.update({ where: { id: match.id }, data: { startsAt: new Date(Date.now() - 1000) } });
  const late = await predict(match, user, 10, 15);
  assert.equal(late.status, 409);
  const deleteLate = await call('DELETE', `/api/matches/${match.id}/predict`, user.token);
  assert.equal(deleteLate.status, 409, 'suppression refusée elle aussi');
  const saved = await prisma.prediction.findUnique({
    where: { userId_matchId: { userId: user.id, matchId: match.id } },
  });
  assert.deepEqual([saved.predictedScore1, saved.predictedScore2], [15, 12]);

  // Verrouillage manuel avant l'heure de début.
  const locked = await createOpenMatch(competition.id, { isLocked: true });
  assert.equal((await predict(locked, user, 15, 10)).status, 409);

  // Tour non vérifié (aucun MatchRound) : clos par prudence.
  const otherCompetition = await createCompetition();
  const unverified = await prisma.match.create({
    data: {
      competitionId: otherCompetition.id,
      player1: 'X',
      player2: 'Y',
      round: 'T8',
      startsAt: new Date(Date.now() + 3600000),
    },
  });
  assert.equal((await predict(unverified, user, 15, 10)).status, 409);

  // Jeton sans compte correspondant : refusé avant toute écriture.
  const ghost = { token: issueToken({ id: 2147483000, isAdmin: false, sessionVersion: 0 }) };
  assert.equal((await predict(await createOpenMatch(competition.id), ghost, 15, 10)).status, 401);
});

test('b) la saisie du résultat recalcule les points (score exact, vainqueur seul, erreur)', opts, async () => {
  const competition = await createCompetition();
  const admin = await createUser({ isAdmin: true });
  const [exact, winnerOnly, wrong] = await Promise.all([createUser(), createUser(), createUser()]);
  const match = await createOpenMatch(competition.id);
  for (const [user, s1, s2] of [
    [exact, 15, 10],
    [winnerOnly, 15, 12],
    [wrong, 8, 15],
  ])
    assert.equal((await predict(match, user, s1, s2)).status, 200);

  const points = async () => {
    const rows = await prisma.prediction.findMany({ where: { matchId: match.id } });
    return Object.fromEntries(rows.map((p) => [p.userId, p.pointsEarned]));
  };
  const setResult = (score1, score2) =>
    call('PUT', `/api/matches/${match.id}/result`, admin.token, { score1, score2, reason: 'Test', sourceUrl: SOURCE });

  const result = await setResult(15, 10);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(await points(), { [exact.id]: 4, [winnerOnly.id]: 1, [wrong.id]: 0 });
  const finished = await prisma.match.findUnique({ where: { id: match.id } });
  assert.equal(finished.isFinished, true);
  assert.equal(finished.winner, 1);

  // Correction du résultat : tous les points sont recalculés.
  assert.equal((await setResult(10, 15)).status, 200);
  assert.deepEqual(await points(), { [exact.id]: 0, [winnerOnly.id]: 0, [wrong.id]: 1 });

  // Un simple joueur ne peut pas saisir de résultat, et le match terminé n'accepte plus de pronostic.
  assert.equal(
    (
      await call('PUT', `/api/matches/${match.id}/result`, exact.token, {
        score1: 15,
        score2: 0,
        reason: 'Test',
        sourceUrl: SOURCE,
      })
    ).status,
    403,
  );
  assert.equal((await predict(match, exact, 10, 15)).status, 409);
});

test('c) le classement additionne matchs, bonus, poules et ajustements par épreuve', opts, async () => {
  const { computeStandings } = require('../../src/services/standings');
  const competition = await createCompetition();
  const elsewhere = await createCompetition();
  const [u1, u2] = await Promise.all([createUser(), createUser()]);

  const match = await createOpenMatch(competition.id, { isFinished: true, score1: 15, score2: 10, winner: 1 });
  const otherMatch = await createOpenMatch(elsewhere.id, { isFinished: true, score1: 15, score2: 10, winner: 1 });
  await prisma.prediction.createMany({
    data: [
      { userId: u1.id, matchId: match.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4, bonusPoints: 1 },
      { userId: u2.id, matchId: match.id, predictedScore1: 15, predictedScore2: 12, pointsEarned: 1 },
      // Autre épreuve : ne doit pas compter dans le classement de cette épreuve.
      { userId: u2.id, matchId: otherMatch.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 4 },
    ],
  });
  const pool = await prisma.pool.create({
    data: {
      competitionId: competition.id,
      name: 'Poule 1',
      closesAt: new Date(),
      isLocked: true,
      isFinal: true,
      fencers: {
        create: [
          { name: 'F1', position: 1 },
          { name: 'F2', position: 2 },
        ],
      },
    },
    include: { fencers: true },
  });
  await prisma.poolPrediction.createMany({
    data: [
      { userId: u1.id, fencerId: pool.fencers[0].id, wins: 1, losses: 0, indicator: 5, pointsEarned: 3 },
      { userId: u2.id, fencerId: pool.fencers[0].id, wins: 1, losses: 0, indicator: 3, pointsEarned: 2 },
      { userId: u2.id, fencerId: pool.fencers[1].id, wins: 0, losses: 1, indicator: -5, pointsEarned: 3 },
    ],
  });
  await prisma.pointAdjustment.createMany({
    data: [
      { userId: u1.id, competitionId: competition.id, points: -2, reason: 'Pénalité de test' },
      { userId: u2.id, competitionId: competition.id, points: 2, reason: 'Geste de test' },
      { userId: u1.id, competitionId: elsewhere.id, points: 50, reason: 'Autre épreuve' },
    ],
  });

  const rows = await computeStandings(prisma, { competitionId: competition.id });
  const row = (u) => rows.find((r) => r.id === u.id);
  assert.deepEqual(
    [row(u1).matchPoints, row(u1).outsiderPoints, row(u1).poolPoints, row(u1).adjustmentPoints, row(u1).totalPoints],
    [4, 1, 3, -2, 6],
  );
  assert.deepEqual(
    [row(u2).matchPoints, row(u2).outsiderPoints, row(u2).poolPoints, row(u2).adjustmentPoints, row(u2).totalPoints],
    [1, 0, 5, 2, 8],
  );
  assert.ok(row(u2).rank < row(u1).rank, 'le meilleur total est classé devant');
});

test('d) le pronostic de poule d’un tireur est refusé dès son premier résultat', opts, async () => {
  const competition = await createCompetition();
  const user = await createUser();
  const pool = await prisma.pool.create({
    data: {
      competitionId: competition.id,
      name: `Poule ${tag()}`,
      closesAt: new Date(),
      lockMode: 'FIRST_RESULT',
      sourceUrl: SOURCE,
      sourcePoolNumber: 1,
      sourceCheckedAt: new Date(), // contrôle FencingTimeLive récent : la saisie est ouverte
      fencers: { create: ['F1', 'F2', 'F3', 'F4'].map((name, i) => ({ name, position: i + 1 })) },
    },
    include: { fencers: { orderBy: { position: 'asc' } } },
  });
  const [first, second] = pool.fencers;
  const put = (fencer, body) => call('PUT', `/api/pools/${pool.id}/fencers/${fencer.id}/prediction`, user.token, body);

  const ok = await put(first, { wins: 2, losses: 1, indicator: 3 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  await prisma.poolFencer.update({ where: { id: first.id }, data: { firstResultAt: new Date() } });
  const late = await put(first, { wins: 3, losses: 0, indicator: 12 });
  assert.equal(late.status, 409);
  assert.equal((await call('DELETE', `/api/pools/${pool.id}/fencers/${first.id}/prediction`, user.token)).status, 409);
  const saved = await prisma.poolPrediction.findUnique({
    where: { userId_fencerId: { userId: user.id, fencerId: first.id } },
  });
  assert.deepEqual([saved.wins, saved.losses, saved.indicator], [2, 1, 3]);

  // Verrou par tireur : les autres tireurs de la poule restent ouverts.
  assert.equal((await put(second, { wins: 1, losses: 2, indicator: -3 })).status, 200);
});

test('e) face-à-face : rencontres passées dans les deux sens, forme récente, match courant exclu', opts, async () => {
  const user = await createUser();
  const t = tag();
  const [a, b, c] = [`ALPHA ${t}`, `BRAVO ${t}`, `CHARLIE ${t}`];
  const old = await createCompetition();
  const done = (player1, player2, score1, score2, days) =>
    prisma.match.create({
      data: {
        competitionId: old.id,
        player1,
        player2,
        score1,
        score2,
        winner: score1 > score2 ? 1 : 2,
        isFinished: true,
        round: 'T16',
        startsAt: new Date(Date.now() - days * 86400000),
      },
    });
  await done(a, b, 15, 9, 30);
  await done(b.toLowerCase(), a, 15, 13, 10); // autre casse, ordre inversé
  await done(a, c, 15, 2, 5);
  const current = await createOpenMatch((await createCompetition()).id, { player1: a, player2: b });
  const res = await call('GET', `/api/matches/${current.id}/h2h`, user.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.summary, { wins1: 1, wins2: 1, poolWins1: 0, poolWins2: 0 });
  assert.deepEqual(
    res.body.meetings.map((m) => m.score),
    [
      [13, 15],
      [15, 9],
    ],
    'most recent first, scores from player 1’s side',
  );
  assert.equal(res.body.form.player1.length, 3, 'all finished bouts of player 1, the current one excluded');
  assert.equal(res.body.form.player1[0].opponent, c);
  assert.equal((await call('GET', '/api/matches/999999999/h2h', user.token)).status, 404);
});

test('f) tableau d’animation : participation et joueurs sans pronostic sur une vraie base', opts, async () => {
  const [active, idle] = [await createUser(), await createUser()];
  const competition = await createCompetition();
  const match = await createOpenMatch(competition.id);
  assert.equal((await predict(match, active, 15, 10)).status, 200);
  const out = await require('../../src/services/engagement').engagement(prisma, competition.tournamentId);
  assert.equal(out.competitions[0].players, 1);
  assert.equal(out.competitions[0].openMatches, 1);
  assert.ok(out.inactive.some((u) => u.id === idle.id));
  assert.ok(!out.inactive.some((u) => u.id === active.id));
});

test('g) réactions et commentaires sur une vraie base (tables, contraintes, compteurs)', opts, async () => {
  const [alice, bob] = [await createUser(), await createUser()];
  const match = await createOpenMatch((await createCompetition()).id);
  assert.equal((await call('PUT', `/api/matches/${match.id}/reaction`, alice.token, { emoji: '👏' })).status, 200);
  assert.equal((await call('PUT', `/api/matches/${match.id}/reaction`, alice.token, { emoji: '🔥' })).status, 200);
  assert.equal((await call('PUT', `/api/matches/${match.id}/reaction`, bob.token, { emoji: '🔥' })).status, 200);
  const posted = await call('POST', `/api/matches/${match.id}/comments`, bob.token, { text: 'Allez !' });
  assert.equal(posted.status, 201);
  const view = await call('GET', `/api/matches/${match.id}/social`, alice.token);
  assert.deepEqual(view.body.reactions, { '🔥': 2 });
  assert.equal(view.body.mine, '🔥');
  assert.deepEqual(
    view.body.comments.map((c) => [c.text, c.mine]),
    [['Allez !', false]],
  );
  assert.equal((await call('DELETE', `/api/matches/${match.id}/comments/${posted.body.id}`, alice.token)).status, 403);
  assert.equal((await call('DELETE', `/api/matches/${match.id}/comments/${posted.body.id}`, bob.token)).status, 204);
  const counts = await require('../../src/services/matchSocial').counts(prisma, [match.id]);
  assert.deepEqual(counts.get(match.id), { reactions: 2, comments: 0 });
});

test('page publique : un joueur retiré du classement public y apparaît anonyme, son rang conservé', opts, async () => {
  const c = await createCompetition();
  const match = await createOpenMatch(c.id);
  const [shown, hidden] = [await createUser(), await createUser()];
  await prisma.prediction.createMany({
    data: [
      { userId: shown.id, matchId: match.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 3 },
      { userId: hidden.id, matchId: match.id, predictedScore1: 15, predictedScore2: 11, pointsEarned: 5 },
    ],
  });
  require('../../src/services/standings').invalidateStandings();
  const bad = await call('PUT', '/api/auth/me/public-listing', hidden.token, { publicListing: 'non' });
  assert.equal(bad.status, 400);
  const off = await call('PUT', '/api/auth/me/public-listing', hidden.token, { publicListing: false });
  assert.deepEqual(off.body, { publicListing: false });
  const page = await call('GET', `/api/public/tournaments/${c.tournamentId}`, shown.token);
  assert.equal(page.status, 200);
  const names = page.body.leaderboard.map((r) => [r.rank, r.name]);
  assert.deepEqual(names[0], [1, 'Pronostiqueur anonyme']);
  assert.equal(names[1][0], 2);
  assert.ok(names[1][1].startsWith('Joueur'));
  assert.ok(!JSON.stringify(page.body).includes(hidden.name));
  // Robots : page HTML rendue côté serveur, liste publique et plan du site.
  const html = await (await fetch(`${base}/api/public/tournaments/${c.tournamentId}/share`)).text();
  assert.match(html, /<h1>Tournoi /);
  assert.match(html, /application\/ld\+json/);
  assert.ok(html.includes('Pronostiqueur anonyme') && !html.includes(hidden.name));
  const list = await (await fetch(`${base}/api/public/tournaments`)).json();
  assert.ok(list.some((t) => t.id === c.tournamentId));
  const xml = await (await fetch(`${base}/api/public/sitemap.xml`)).text();
  assert.ok(xml.includes(`/tournoi/${c.tournamentId}</loc>`));
  assert.ok(xml.includes('/resultats</loc>'));
  // Onglet Résultats sans compte : aucun pronostic dans les réponses.
  const results = await fetch(`${base}/api/public/results`);
  assert.equal(results.status, 200);
  const publicMatches = await (await fetch(`${base}/api/public/competitions/${c.id}/matches`)).json();
  assert.equal(publicMatches.length, 1);
  assert.equal(publicMatches[0].predictions, undefined);
  const pools = await fetch(`${base}/api/public/competitions/${c.id}/pools`);
  assert.equal(pools.status, 200);
  const fencer = await (await fetch(`${base}/api/public/fencer?name=${encodeURIComponent(match.player1)}`)).json();
  assert.equal(fencer.summary.competitions, 0);
});

test('invitation par lien et duel depuis les classements', opts, async () => {
  const c = await createCompetition();
  const match = await createOpenMatch(c.id);
  const [owner, friend] = [await createUser(), await createUser()];
  const created = await call('POST', '/api/community/leagues', owner.token, { name: 'Les amis', kind: 'PRIVATE' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { code } = created.body;
  const info = await (await fetch(`${base}/api/public/invitations/${code.toLowerCase()}`)).json();
  assert.equal(info.name, 'Les amis');
  assert.equal(info.members, 1);
  assert.equal(info.tournament, null, 'groupe permanent : aucun tournoi attaché');
  assert.equal((await fetch(`${base}/api/public/invitations/ZZ`)).status, 400);
  const calendar = await (await fetch(`${base}/api/public/calendar`)).json();
  assert.ok(Array.isArray(calendar.events));
  assert.equal((await fetch(`${base}/api/public/invitations/${'0'.repeat(24)}`)).status, 404);
  // Duel : rien n'est dévoilé tant que le match n'est pas terminé.
  await prisma.prediction.createMany({
    data: [
      { userId: owner.id, matchId: match.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 3 },
      { userId: friend.id, matchId: match.id, predictedScore1: 12, predictedScore2: 15, pointsEarned: 0 },
    ],
  });
  const before = await call('GET', `/api/community/duel/${friend.id}?tournamentId=${c.tournamentId}`, owner.token);
  assert.equal(before.status, 200);
  assert.equal(before.body.rows.length, 0);
  await prisma.match.update({ where: { id: match.id }, data: { isFinished: true, score1: 15, score2: 9 } });
  const after = await call('GET', `/api/community/duel/${friend.id}?competitionId=${c.id}`, owner.token);
  assert.equal(after.body.rows.length, 1);
  assert.deepEqual([after.body.totals.me, after.body.totals.them], [3, 0]);
  assert.equal(after.body.opponent.id, friend.id);
  assert.equal((await call('GET', `/api/community/duel/${owner.id}`, owner.token)).status, 400);
  // Groupe permanent : classement par tournoi ou sur la saison ; départ puis retour.
  assert.equal((await call('POST', '/api/community/join', friend.token, { code })).status, 200);
  const league = created.body.id;
  const onTournament = await call(
    'GET',
    `/api/community/leagues/${league}?tournamentId=${c.tournamentId}`,
    owner.token,
  );
  assert.deepEqual(
    onTournament.body.ranking.map((r) => r.id),
    [owner.id, friend.id],
  );
  const season = await call('GET', `/api/community/leagues/${league}`, friend.token);
  assert.equal(season.body.tournamentId, null);
  assert.equal(season.body.league.memberCount, 2);
  assert.equal((await call('POST', `/api/community/leagues/${league}/leave`, friend.token)).status, 200);
  assert.equal((await call('GET', `/api/community/leagues/${league}`, friend.token)).status, 403);
  assert.equal((await call('POST', '/api/community/join', friend.token, { code })).status, 200);
  const mine = await call('GET', '/api/community/leagues', friend.token);
  assert.equal(mine.body.find((l) => l.id === league)._count.members, 2);
  // Un seul club à la fois.
  const clubA = await call('POST', '/api/community/leagues', owner.token, { name: 'Club A', kind: 'CLUB' });
  assert.equal(clubA.status, 201);
  const clubB = await call('POST', '/api/community/leagues', owner.token, { name: 'Club B', kind: 'CLUB' });
  assert.equal(clubB.status, 409);
  const clubs = await call('GET', `/api/community/clubs/${c.tournamentId}`, owner.token);
  assert.equal(clubs.status, 200);
});
