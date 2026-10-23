const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { url, dedicatedUrl, freshDatabase } = require('./helpers');
const F = require('../../src/services/fencerFollows');
const { search } = require('../../src/services/fencerDirectory');
const { fencerProfile } = require('../../src/services/fencerProfile');
const skip = !url;
let db;
if (!skip) {
  process.env.DATABASE_URL = dedicatedUrl('participations');
  db = require('../../src/lib/prisma');
}
before(async () => {
  if (!skip) await freshDatabase('participations');
});
after(async () => db?.$disconnect());
test(
  'PostgreSQL: one directory row, legacy favorite preserved, idempotent follow and scoped history',
  { skip },
  async () => {
    const name = 'EXEMPLE Alex';
    const user = await db.user.create({
      data: { name: 'TEST', email: 'participations@example.invalid', password: 'test' },
    });
    const otherUser = await db.user.create({
      data: { name: 'TEST 2', email: 'participations-2@example.invalid', password: 'test' },
    });
    const t = await db.tournament.create({ data: { name: 'Tournoi fictif' } });
    const entries = [];
    for (let i = 0; i < 4; i++) {
      const country = i === 3 ? 'ITA' : 'RUS';
      const profile = await db.fencerAffiliation.create({
        data: { identityKey: 'provisional-' + i, name, nameKey: 'EXEMPLE ALEX', country },
      });
      const competition = await db.competition.create({
        data: {
          tournamentId: t.id,
          name: 'Épreuve ' + i,
          podiumRoster: [{ id: 'entry-' + i, name, country }],
          affiliationEntries: { create: { entryId: 'entry-' + i, affiliationId: profile.id } },
        },
      });
      entries.push({ profile, competition });
    }
    const old = await db.followedFencer.create({
      data: {
        userId: user.id,
        identityKey: 'profile:' + entries[1].profile.id,
        affiliationId: entries[1].profile.id,
        name,
        country: 'RUS',
        originEntryId: '',
        club: '',
      },
    });
    const match = await db.match.create({
      data: {
        competitionId: entries[0].competition.id,
        player1: name,
        player2: 'AUTRE Camille',
        round: 'T2',
        isFinished: true,
        pointsPending: false,
        winner: 1,
        score1: 15,
        score2: 10,
      },
    });
    const pred = await db.prediction.create({
      data: { userId: user.id, matchId: match.id, predictedScore1: 15, predictedScore2: 10, pointsEarned: 6 },
    });
    const stable = async () =>
      JSON.stringify(
        await Promise.all([
          db.followedFencer.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } }),
          db.prediction.findUnique({ where: { id: pred.id } }),
          db.match.findMany({ orderBy: { id: 'asc' } }),
          db.fencerAffiliation.findMany({ orderBy: { id: 'asc' } }),
          db.fencerAffiliationEntry.findMany({ orderBy: { id: 'asc' } }),
        ]),
      );
    const beforeRead = await stable();
    const args = { query: 'exemple', offset: 0 };
    const result = await search(db, user.id, args);
    assert.equal(result.total, 2); // une fiche RUS (3 participations), un vrai homonyme ITA
    const rus = result.results.find((p) => p.country === 'RUS');
    assert.equal(rus.events.length, 3);
    assert.equal(rus.favoriteId, old.id);
    assert.equal((await F.followProfile(db, user.id, entries[2].profile.id)).id, old.id);
    const c = entries[2].competition;
    assert.equal((await F.follow(db, user.id, c.id, 'entry-2')).id, old.id);
    for (const { competition } of entries.slice(0, 3)) {
      const list = await F.list(db, user.id, competition.id);
      assert.equal(list.links[0].favoriteId, old.id);
    }
    assert.equal((await F.list(db, user.id, entries[3].competition.id)).links.length, 0);
    const profile = await fencerProfile(db, name, { affiliationId: rus.affiliationId });
    assert.equal(profile.summary.competitions, 3);
    assert.ok(profile.competitions.every((p) => p.competitionId !== entries[3].competition.id));
    await assert.rejects(
      fencerProfile(db, 'AUTRE Camille', { affiliationId: rus.affiliationId }),
      (e) => e.status === 404,
    );
    await assert.rejects(fencerProfile(db, name, { affiliationId: NaN }), (e) => e.status === 400);
    assert.equal(await stable(), beforeRead);
    const saved = await Promise.all(
      entries.slice(0, 3).map(({ profile }) => F.followProfile(db, otherUser.id, profile.id)),
    );
    assert.equal(new Set(saved.map((f) => f.id)).size, 1);
    assert.equal(await db.followedFencer.count({ where: { userId: otherUser.id } }), 1);
    assert.equal(await stable(), beforeRead);
    // Une nouvelle preuve d'homonymie bloque le regroupement, sans supprimer les anciens suivis.
    const duplicate = await db.fencerAffiliation.create({
      data: { identityKey: 'duplicate', name, nameKey: 'EXEMPLE ALEX', country: 'RUS' },
    });
    await db.fencerAffiliationEntry.create({
      data: { competitionId: entries[0].competition.id, entryId: 'another-entry', affiliationId: duplicate.id },
    });
    const split = await search(db, user.id, args);
    assert.equal(split.results.filter((p) => p.country === 'RUS').length, 4);
    assert.deepEqual(await db.followedFencer.findUnique({ where: { id: old.id } }), old);
  },
);
