const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const { fixture, emptyPools, rosterHtml, mennecyEntries } = require('./engardeScenario');
const skip = url ? false : 'TEST_DATABASE_URL non défini';
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('engarde_stages');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('engarde_stages');
});
after(async () => db?.$disconnect());
test(
  'Hénin : 3/2 tours samedi, puis poules et tableau dimanche dans la même compétition ; pronostics et points préservés',
  { skip },
  async () => {
    const { control } = require('../../src/services/engardeSync');
    const { existingAnchor } = require('../../src/services/engardeStages');
    const { configuration } = require('../../src/services/ftlConfiguration');
    const { parsePools } = require('../../src/services/engardeParser');
    const admin = await db.user.create({
      data: { email: 'stages@example.invalid', name: 'TEST', password: 'test', isAdmin: true },
    });
    const tournament = await db.tournament.create({
      data: { name: 'TEST WEEKEND', ftlSourceUrl: 'https://engarde-service.com/tournament/heninbeaumont/seniorf1026' },
    });
    for (const [gender, compe, rounds] of [
      ['Hommes', 'fh_samedi', 3],
      ['Dames', 'fd_samedi', 2],
    ]) {
      const c = await db.competition.create({
        data: {
          name: `Fleuret ${gender} senior`,
          ftlEventId: `ENGARDE:heninbeaumont/seniorf1026/${compe}`,
          tournamentId: tournament.id,
          podiumFormat: 'INDIVIDUAL',
        },
      });
      const cfg = {
        provider: 'engarde',
        org: 'heninbeaumont',
        tournamentSlug: 'seniorf1026',
        compe,
        event: `Fleuret ${gender} senior`,
        format: 'INDIVIDUAL',
        date: '2026-10-17',
        time: '10:00',
        timezone: 'Europe/Paris',
        eventSourceUrl: `https://engarde-service.com/competition/heninbeaumont/seniorf1026/${compe}`,
      };
      let publishedCompe = gender === 'Hommes' ? 'fhs_samedi' : compe;
      const sources = [
        cfg.eventSourceUrl.replace(compe, publishedCompe),
        cfg.eventSourceUrl.replace(compe, compe + '-national'),
      ];
      await db.auditLog.create({
        data: {
          actorId: admin.id,
          action: 'Configuration FTL validée',
          targetType: 'Competition',
          targetId: c.id,
          after: cfg,
        },
      });
      const anchor = await existingAnchor(db, { ...cfg, compe: publishedCompe });
      assert.equal(anchor?.id, c.id);
      const files = [
        {
          'tireurs.htm': rosterHtml(mennecyEntries()),
          ...Object.fromEntries(Array.from({ length: rounds }, (_, i) => [`poules${i + 1}.htm`, emptyPools()])),
        },
        {},
      ];
      let main = false;
      const xml = () =>
        `<?xml version="1.0"?><comps>${[0, ...(main ? [1] : [])].map((i) => `<comp org="heninbeaumont" evt="seniorf1026" compe="${i ? compe + '-national' : publishedCompe}" sexe="${gender === 'Hommes' ? 'm' : 'f'}" arme="f" estindividuelle="1" date="2026 10 ${i ? 18 : 17}" startTime="${i ? '08:00:00' : '10:00:00'}"><categorie>senior</categorie><titre>TEST</titre></comp>`).join('')}</comps>`;
      const client = () => ({
        competitions: async () => xml(),
        get: async (u) => {
          const i = u.startsWith(sources[1]) ? 1 : 0;
          if (u === sources[i])
            return Object.keys(files[i])
              .map((f) => `<a class="link-competition" href="${new URL(sources[i]).pathname}/${f}">${f}</a>`)
              .join('');
          const f = u.slice(sources[i].length + 1);
          if (!(f in files[i])) throw new Error('Page non publiée demandée');
          return files[i][f];
        },
      });
      const run = async () =>
        control(
          db,
          await db.competition.findUnique({ where: { id: c.id } }),
          await configuration(db, c.id),
          admin.id,
          { token: null },
          client(),
        );
      await run();
      assert.equal(
        (await db.competition.findUnique({ where: { id: c.id } })).ftlEventId,
        `ENGARDE:heninbeaumont/seniorf1026/${publishedCompe}`,
      );
      const initial = await db.pool.findMany({
        where: { competitionId: c.id },
        include: { fencers: true },
        orderBy: { id: 'asc' },
      });
      assert.equal(initial.length, 2 * rounds);
      assert.ok(initial.every((p) => p.name.includes('J1') && p.startsAt.toISOString().startsWith('2026-10-17')));
      const f = initial[0].fencers[0];
      const p = await db.poolPrediction.create({
        data: {
          userId: admin.id,
          fencerId: f.id,
          wins: 2,
          losses: 4,
          indicator: -3,
          savedAt: new Date(),
          pointsEarned: 7,
        },
      });
      // Publication réelle du résultat : un recalcul est légitime ; capturer la référence après ce recalcul.
      files[0]['poules1.htm'] = fixture('fdm20-poules-1-2.html');
      await run();
      const baseline = await db.poolPrediction.findUnique({ where: { id: p.id } });
      main = true;
      files[1] = {
        'tireurs.htm': rosterHtml(mennecyEntries()),
        'poules1.htm': emptyPools().replaceAll('12:30', '08:00'),
        'tableau16.htm': fixture('fdm20-tableau16.html'),
      };
      await run();
      const all = await db.pool.findMany({
        where: { competitionId: c.id },
        include: { fencers: true },
        orderBy: { id: 'asc' },
      });
      assert.equal(all.length, 2 * (rounds + 1));
      assert.ok(initial.every((old) => all.some((p) => p.id === old.id && p.sourceUrl === old.sourceUrl)));
      assert.ok(
        all
          .filter((p) => p.sourceUrl.startsWith(sources[1]))
          .every(
            (p) => p.name.startsWith(`Tour ${rounds + 1} · J2`) && p.startsAt.toISOString().startsWith('2026-10-18'),
          ),
      );
      assert.deepEqual(await db.poolPrediction.findUnique({ where: { id: p.id } }), baseline);
      const matches = await db.match.findMany({ where: { competitionId: c.id } });
      assert.equal(matches.length, 15);
      assert.ok(matches.every((m) => m.startsAt.toISOString().startsWith('2026-10-18')));
      await run();
      assert.deepEqual(
        (await db.pool.findMany({ where: { competitionId: c.id }, orderBy: { id: 'asc' }, select: { id: true } })).map(
          (p) => p.id,
        ),
        all.map((p) => p.id),
      );
      assert.deepEqual(await db.poolPrediction.findUnique({ where: { id: p.id } }), baseline);
      publishedCompe += '-moved';
      await assert.rejects(run(), /déplacée après import/);
      assert.deepEqual(await db.poolPrediction.findUnique({ where: { id: p.id } }), baseline);
      assert.equal(await db.competition.count({ where: { tournamentId: tournament.id } }), gender === 'Hommes' ? 1 : 2);
    }
  },
);
