// Pires scénarios d'une épreuve engarde-service, sur un vrai PostgreSQL : site en panne, page tronquée,
// tirage refait, forfait à l'appel, score corrigé, tableau refait, abandon, résultat retiré, renommage…
// Chaque scénario vérifie qu'aucune donnée n'est perdue ou inventée, et que les points restent justes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');

let skip = url ? false : 'TEST_DATABASE_URL non défini';
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('worst_engarde');
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
  if (!skip) await freshDatabase('worst_engarde');
});
after(async () => {
  await prisma?.$disconnect();
});

const S = require('./engardeScenario');
const E = require('../../src/services/engardeParser');
const POOLS = () => S.fixture('fdm20-poules-1-2.html');
const entries = () => S.mennecyEntries();
// Les 16 tireuses du vrai tableau de Mennecy, dans l'ordre du tableau.
const tableauEntrants = () => {
  const m = E.parseTableaus([S.fixture('fdm20-tableau16.html')]).matches.filter((x) => x.round === 'T16');
  return m.flatMap((x, i) => [
    { name: x.player1, club: x.club1, seed: i + 1 },
    { name: x.player2, club: x.club2, seed: 16 - i },
  ]);
};
const fencer = async (id, name) =>
  (await prisma.poolFencer.findMany({ where: { name, pool: { competitionId: id } } }))[0];
const sub = async (userId) =>
  prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: `https://fcm.googleapis.com/fcm/send/${userId}-${Math.random()}`,
      p256dh: 'x',
      auth: 'y',
      tournamentIds: [],
      competitionIds: [],
    },
  });

test('site officiel en panne pendant les poules : rien n’est perdu, reprise au retour du site', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  ev.site.files = { 'tireurs.htm': S.rosterHtml(entries()), 'poules1.htm': S.emptyPools() };
  await ev.run();
  const bolore = await fencer(ev.id, 'BOLORE Mélisande');
  const p = await ev.player();
  await prisma.poolPrediction.create({
    data: { userId: p.id, fencerId: bolore.id, wins: 6, losses: 0, indicator: 21, savedAt: new Date() },
  });
  ev.site.down = 'engarde-service ne répond pas. Réessayez plus tard.';
  const failed = await ev.attempt();
  assert.ok(failed.error?.status, `erreur propre attendue, reçu : ${failed.error?.message || 'aucune'}`);
  assert.equal(await prisma.pool.count({ where: { competitionId: ev.id } }), 2);
  assert.equal(await prisma.poolPrediction.count({ where: { userId: p.id } }), 1);
  ev.site.down = null;
  ev.site.files['poules1.htm'] = POOLS();
  await ev.run();
  const done = await fencer(ev.id, 'BOLORE Mélisande');
  assert.deepEqual([done.wins, done.indicator], [6, 21]);
  assert.ok((await prisma.poolPrediction.findFirst({ where: { userId: p.id } })).pointsEarned > 0);
});

test('page de poules tronquée (publication en cours) : aucun bilan inventé', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  const full = POOLS();
  ev.site.files = {
    'tireurs.htm': S.rosterHtml(entries()),
    'poules1.htm': full.slice(0, Math.floor(full.length * 0.6)),
  };
  const r = await ev.attempt();
  assert.ok(!r.error || r.error.status, 'pas de plantage');
  const truth = new Map(E.parsePools(full).flatMap((x) => x.rows.map((row) => [row.name, row])));
  for (const f of await prisma.poolFencer.findMany({ where: { pool: { competitionId: ev.id } } }))
    if (f.wins !== null) assert.equal(f.wins, truth.get(f.name).wins, `${f.name} : bilan incohérent`);
  ev.site.files['poules1.htm'] = full;
  await ev.run();
  assert.equal((await fencer(ev.id, 'LI Helene Zhixuan')).wins, 5);
});

test(
  'poules refaites juste avant le début : seule la poule modifiée est à refaire, joueurs prévenus',
  opts,
  async () => {
    const ev = await S.engardeEvent(prisma);
    ev.site.files = { 'tireurs.htm': S.rosterHtml(entries()), 'poules1.htm': S.emptyPools() };
    await ev.run();
    const p = await ev.player();
    await sub(p.id);
    const inPool1 = await fencer(ev.id, 'CHEVREAU Clementine');
    const inPool2 = await fencer(ev.id, 'LI Helene Zhixuan');
    for (const f of [inPool1, inPool2])
      await prisma.poolPrediction.create({
        data: { userId: p.id, fencerId: f.id, wins: 3, losses: 3, indicator: 0, savedAt: new Date() },
      });
    // Tirage refait : CHEVREAU remplacée par GIMARD (engagée, absente des poules jusque-là).
    ev.site.files['poules1.htm'] = S.emptyPools(
      POOLS().replace('CHEVREAU Clementine', 'GIMARD Ninon').replace('PARIS RCF', 'ANTONY'),
    );
    const s = await ev.run();
    const names = (await prisma.poolFencer.findMany({ where: { pool: { competitionId: ev.id } } })).map((f) => f.name);
    assert.ok(names.includes('GIMARD Ninon') && !names.includes('CHEVREAU Clementine'), 'nouvelle composition');
    const kept = await prisma.poolPrediction.findMany({ where: { userId: p.id }, include: { fencer: true } });
    assert.deepEqual(
      kept.map((k) => k.fencer.name),
      ['LI Helene Zhixuan'],
      'pronostic de la poule inchangée conservé, celui de la poule refaite à refaire',
    );
    assert.ok(s.pools?.recomposed?.length, 'recomposition signalée');
    assert.ok(await prisma.pushDelivery.count({ where: { competitionId: ev.id, kind: 'POOLS' } }), 'joueurs prévenus');
  },
);

test(
  'tireuse absente à l’appel (DNS) : retirée du bilan, joueurs qui l’ont sur leur podium prévenus',
  opts,
  async () => {
    const ev = await S.engardeEvent(prisma);
    ev.site.files = { 'tireurs.htm': S.rosterHtml(entries()), 'poules1.htm': S.emptyPools() };
    await ev.run();
    const c = await prisma.competition.findUnique({ where: { id: ev.id } });
    const id = (n) => c.podiumRoster.find((e) => e.name === n).id;
    const p = await ev.player();
    await sub(p.id);
    await prisma.podiumPrediction.create({
      data: {
        userId: p.id,
        competitionId: ev.id,
        gold: 'CAZILHAC Iris',
        silver: 'LI Helene Zhixuan',
        bronze1: 'BOLORE Mélisande',
        bronze2: 'ROBINET Lea',
        selectionIds: {
          gold: id('CAZILHAC Iris'),
          silver: id('LI Helene Zhixuan'),
          bronze1: id('BOLORE Mélisande'),
          bronze2: id('ROBINET Lea'),
        },
      },
    });
    // CAZILHAC forfait : ses cases restent vides et ses statistiques indiquent « DNS ».
    const dns = POOLS().replace(
      /(<td>CAZILHAC Iris<\/td>.*?)<td>0\.000<\/td><td>-19<\/td><td>11<\/td>/s,
      '$1<td>DNS</td><td></td><td></td>',
    );
    ev.site.files['poules1.htm'] = dns;
    const s = await ev.run();
    assert.ok(!s.warnings.some((w) => /CAZILHAC/.test(w) && /ambigu|incohérent/.test(w)), s.warnings.join(' | '));
    assert.ok(
      await prisma.pushDelivery.count({ where: { competitionId: ev.id, kind: 'PODIUM_OUT' } }),
      'alerte podium envoyée',
    );
  },
);

test('score de poule corrigé après coup : points recalculés une seule fois', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  ev.site.files = { 'tireurs.htm': S.rosterHtml(entries()), 'poules1.htm': POOLS() };
  await ev.run();
  const bolore = await fencer(ev.id, 'BOLORE Mélisande');
  const p = await ev.player();
  const pred = await prisma.poolPrediction.create({
    data: { userId: p.id, fencerId: bolore.id, wins: 6, losses: 0, indicator: 21, savedAt: new Date() },
  });
  await ev.run();
  const before = (await prisma.poolPrediction.findUnique({ where: { id: pred.id } })).pointsEarned;
  // Correction : MARCEL VU avait mis 3 touches à BOLORE, pas 2 (statistiques mises à jour par le DT).
  const corrected = POOLS()
    .replace('<td class="HGBD"></td><td class="HBD">2</td>', '<td class="HGBD"></td><td class="HBD">3</td>')
    .replace('<td>0.667</td><td>8</td><td>25</td>', '<td>0.667</td><td>9</td><td>26</td>')
    .replace('<td>1.000</td><td>21</td><td>30</td>', '<td>1.000</td><td>20</td><td>30</td>');
  ev.site.files['poules1.htm'] = corrected;
  await ev.run();
  await ev.run();
  assert.equal((await fencer(ev.id, 'BOLORE Mélisande')).indicator, 20);
  const after = (await prisma.poolPrediction.findUnique({ where: { id: pred.id } })).pointsEarned;
  assert.ok(after < before, `points revus à la baisse (${before} → ${after})`);
});

// Tableau de 16 importé, joueurs avec un pronostic sur le premier match.
async function tableauEvent(results, extra = {}) {
  const ev = await S.engardeEvent(prisma);
  ev.site.files = {
    'tireurs.htm': S.rosterHtml(entries()),
    'poules1.htm': POOLS(),
    'tableau16.htm': S.tableauHtml(tableauEntrants(), results),
    ...extra,
  };
  await ev.run();
  return ev;
}
const match = (id, key) => prisma.match.findFirst({ where: { competitionId: id, sourceKey: key } });

test('score de tableau corrigé : points recalculés, aucune correction en double', opts, async () => {
  const ev = await tableauEvent([[{ w: 1, score: '15/10' }]]);
  const p = await ev.player();
  const m = await match(ev.id, 'T16:1');
  const pred = await prisma.prediction.create({
    data: { userId: p.id, matchId: m.id, predictedScore1: 15, predictedScore2: 10 },
  });
  await ev.run();
  const exact = (await prisma.prediction.findUnique({ where: { id: pred.id } })).pointsEarned;
  ev.site.files['tableau16.htm'] = S.tableauHtml(tableauEntrants(), [[{ w: 1, score: '15/12' }]]);
  const s = await ev.run();
  assert.equal(s.corrections, 1);
  const corrected = await match(ev.id, 'T16:1');
  assert.deepEqual([corrected.score1, corrected.score2], [15, 12]);
  const now = (await prisma.prediction.findUnique({ where: { id: pred.id } })).pointsEarned;
  assert.ok(now < exact, `score exact perdu (${exact} → ${now})`);
  assert.equal((await ev.run()).corrections, 0, 'idempotent');
});

test('mauvais vainqueur saisi puis corrigé : vainqueur et tour suivant remis d’aplomb', opts, async () => {
  const ev = await tableauEvent([[{ w: 1, score: '15/14' }]]);
  const p = await ev.player();
  const m = await match(ev.id, 'T16:1');
  const pred = await prisma.prediction.create({
    data: { userId: p.id, matchId: m.id, predictedScore1: 14, predictedScore2: 15 },
  });
  await ev.run();
  ev.site.files['tableau16.htm'] = S.tableauHtml(tableauEntrants(), [[{ w: 2, score: '15/14' }]]);
  const s = await ev.attempt();
  assert.ok(!s.error, s.error?.message);
  const fixed = await match(ev.id, 'T16:1');
  assert.equal(fixed.winner, 2);
  assert.ok((await prisma.prediction.findUnique({ where: { id: pred.id } })).pointsEarned > 0, 'bon pronostic payé');
});

test(
  'tableau refait avant le premier assaut : anciennes affiches annulées, pronostics gardés sans points',
  opts,
  async () => {
    const ev = await tableauEvent([]);
    const p = await ev.player();
    const m1 = await match(ev.id, 'T16:1');
    await prisma.prediction.create({ data: { userId: p.id, matchId: m1.id, predictedScore1: 15, predictedScore2: 3 } });
    const swapped = tableauEntrants();
    [swapped[1], swapped[3]] = [swapped[3], swapped[1]];
    ev.site.files['tableau16.htm'] = S.tableauHtml(swapped, []);
    const s = await ev.attempt();
    assert.ok(!s.error, s.error?.message);
    const all = await prisma.match.findMany({ where: { competitionId: ev.id, round: 'T16' } });
    const live = all.filter((x) => x.resultType !== 'CANCELLED');
    assert.equal(live.length, 8, 'huit affiches valides');
    assert.ok(
      live.some((x) => x.player2 === swapped[1].name && x.player1 === swapped[0].name),
      'nouvelle affiche',
    );
    assert.equal(await prisma.prediction.count({ where: { userId: p.id } }), 1, 'pronostic conservé');
  },
);

test('abandon au tableau : qualifiée sans score, le tableau continue', opts, async () => {
  const ev = await tableauEvent([[{ w: 2, score: 'DNF' }]]);
  const m = await match(ev.id, 'T16:1');
  assert.deepEqual([m.isFinished, m.resultType, m.winner], [true, 'MEDICAL_WITHDRAWAL', 2]);
});

test('page de tableau indisponible un moment : aucune affiche annulée', opts, async () => {
  const ev = await tableauEvent(S.fullResults(16).slice(0, 1));
  const before = await prisma.match.count({ where: { competitionId: ev.id, NOT: { resultType: 'CANCELLED' } } });
  ev.site.files['tableau16.htm'] = new E.EngardeError('engarde-service indisponible (503).');
  const s = await ev.attempt();
  assert.ok(!s.error || s.error.status);
  assert.equal(await prisma.match.count({ where: { competitionId: ev.id, NOT: { resultType: 'CANCELLED' } } }), before);
});

test('résultat retiré de la source puis republié : points suspendus puis rendus', opts, async () => {
  const ev = await tableauEvent([[{ w: 1, score: '15/10' }]]);
  const p = await ev.player();
  const m = await match(ev.id, 'T16:1');
  const pred = await prisma.prediction.create({
    data: { userId: p.id, matchId: m.id, predictedScore1: 15, predictedScore2: 10 },
  });
  await ev.run();
  const paid = (await prisma.prediction.findUnique({ where: { id: pred.id } })).pointsEarned;
  ev.site.files['tableau16.htm'] = S.tableauHtml(tableauEntrants(), []);
  await ev.attempt();
  const removed = await match(ev.id, 'T16:1');
  assert.ok(removed.syncIssue || removed.isFinished, 'résultat conservé ou signalé, jamais effacé en silence');
  ev.site.files['tableau16.htm'] = S.tableauHtml(tableauEntrants(), [[{ w: 1, score: '15/10' }]]);
  await ev.run();
  const back = await match(ev.id, 'T16:1');
  assert.deepEqual([back.isFinished, back.syncIssue, back.pointsPending], [true, null, false]);
  assert.equal((await prisma.prediction.findUnique({ where: { id: pred.id } })).pointsEarned, paid);
});

test('score illisible sur un match : points en attente, le reste du tableau continue', opts, async () => {
  const ev = await tableauEvent([
    [
      { w: 1, score: '15/10' },
      { w: 2, score: '' },
      { w: 1, score: '15/3' },
    ],
  ]);
  const pending = await match(ev.id, 'T16:2');
  assert.deepEqual([pending.pointsPending, pending.winner], [true, 2]);
  assert.ok(pending.progressionConfirmedAt, 'qualifiée confirmée');
  const ok = await match(ev.id, 'T16:3');
  assert.deepEqual([ok.isFinished, ok.pointsPending], [true, false]);
});

test('nom corrigé dans la liste des engagés : même tireuse, pronostics de podium conservés', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  ev.site.files = { 'tireurs.htm': S.rosterHtml(entries()) };
  await ev.run();
  const before = (await prisma.competition.findUnique({ where: { id: ev.id } })).podiumRoster;
  const gimard = before.find((e) => e.name === 'GIMARD Ninon');
  ev.site.files['tireurs.htm'] = S.rosterHtml(
    entries().map((e) => (e.name === 'GIMARD Ninon' ? { ...e, name: 'GIMARD Ninon Marie' } : e)),
  );
  await ev.run();
  const after = (await prisma.competition.findUnique({ where: { id: ev.id } })).podiumRoster;
  const renamed = after.find((e) => e.name === 'GIMARD Ninon Marie');
  assert.equal(renamed?.id, gimard.id, 'même identifiant');
  assert.equal(after.filter((e) => e.active !== false).length, before.length);
});

test('engagée ajoutée en retard : ajoutée sans casser les poules', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  ev.site.files = { 'tireurs.htm': S.rosterHtml(entries()), 'poules1.htm': S.emptyPools() };
  await ev.run();
  ev.site.files['tireurs.htm'] = S.rosterHtml([...entries(), { name: 'NOUVELLE Tireuse', club: 'ANTONY' }]);
  const s = await ev.run();
  const c = await prisma.competition.findUnique({ where: { id: ev.id } });
  assert.ok(c.podiumRoster.some((e) => e.name === 'NOUVELLE Tireuse'));
  assert.equal(await prisma.pool.count({ where: { competitionId: ev.id } }), 2);
  assert.ok(!s.warnings.some((w) => /Poule/.test(w)), s.warnings.join(' | '));
});

test('homonymes de clubs différents : chacune dans sa poule', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  const list = [...entries(), { name: 'ROBINET Lea', club: 'BLR92' }];
  ev.site.files = { 'tireurs.htm': S.rosterHtml(list), 'poules1.htm': S.emptyPools() };
  const s = await ev.run();
  assert.equal(await prisma.pool.count({ where: { competitionId: ev.id } }), 2, s.warnings.join(' | '));
  assert.ok(await fencer(ev.id, 'ROBINET Lea'));
});

test('classement final en désaccord avec la finale : podium non validé, signalé', opts, async () => {
  const wrong = `<table><tr><th>RG</th><th>NOM</th><th>PRÉNOM</th><th>CLUB</th></tr>
<tr><td>1</td><td>GIMARD</td><td>NINON</td><td>ANTONY</td></tr>
<tr><td>2</td><td>BOLORE</td><td>MÉLISANDE</td><td>ANTONY</td></tr>
<tr><td>3</td><td>VALIERE</td><td>LISE</td><td>PARIS CEP</td></tr>
<tr><td>3</td><td>MUGERIN</td><td>LOANE</td><td>SGLP ESCRIME</td></tr></table>`;
  const ev = await tableauEvent(S.fullResults(16), { 'clasfinal.htm': wrong });
  const c = await prisma.competition.findUnique({ where: { id: ev.id } });
  assert.equal(c.podiumResolvedAt, null, 'podium non validé');
});

test('deux contrôles lancés en même temps : pas de doublon', opts, async () => {
  const ev = await S.engardeEvent(prisma);
  ev.site.files = {
    'tireurs.htm': S.rosterHtml(entries()),
    'poules1.htm': POOLS(),
    'tableau16.htm': S.tableauHtml(tableauEntrants(), S.fullResults(16)),
  };
  const { syncCompetition } = require('../../src/services/ftlSync');
  await Promise.allSettled([
    syncCompetition(prisma, ev.id, ev.admin.id, { engarde: ev.client }),
    syncCompetition(prisma, ev.id, ev.admin.id, { engarde: ev.client }),
  ]);
  await ev.run();
  assert.equal(await prisma.pool.count({ where: { competitionId: ev.id } }), 2);
  assert.equal(await prisma.match.count({ where: { competitionId: ev.id } }), 15);
});
