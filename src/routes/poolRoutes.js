const express = require('express');
const prisma = require('../lib/prisma');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const { fail, id, validatePrediction, closed, fencerClosed, sourceUnavailable, validateSource, comparison, validateResults, poolPoints } = require('../services/poolRules');

function createPoolRouter(db = prisma) {
  const router = express.Router();
  router.use(auth);
  const handle = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'P2002') return res.status(409).json({ error: 'Cette poule existe déjà dans la compétition.' });
      console.error('Erreur poules:', error.code || error.message);
      res.status(500).json({ error: 'Impossible de traiter les poules. Réessayez.' });
    }
  };
  // All mutations for a pool acquire the same lock, preventing a save from
  // racing a manual closure or result publication. No migration is run here.
  const withPool = (poolId, fn) => db.$transaction(async tx => {
    const rows = await tx.$queryRaw`SELECT "id" FROM "Pool" WHERE "id" = ${poolId} FOR UPDATE`;
    if (!rows.length) fail('Poule introuvable.', 404);
    const pool = await tx.pool.findUnique({ where: { id: poolId }, include: { fencers: true } });
    return fn(tx, pool);
  });

  router.get('/', handle(async (req, res) => {
    const competitionId = id(req.query.competitionId);
    const pools = await db.pool.findMany({
      where: { competitionId }, orderBy: { id: 'asc' },
      include: { fencers: { orderBy: { position: 'asc' }, include: { predictions: { where: { userId: req.user.userId } } } } },
    });
    res.json(pools.map(pool => ({
      ...pool, isClosed: closed(pool), sourceUnavailable: sourceUnavailable(pool),
      fencers: pool.fencers.map(({ predictions, ...fencer }) => ({
        ...fencer, isClosed: fencerClosed(pool, fencer), prediction: predictions[0] || null,
        comparison: comparison(predictions[0], fencer, pool.isFinal),
      })),
    })));
  }));

  router.post('/', admin, handle(async (req, res) => {
    const competitionId = id(req.body.competitionId);
    const rankingSystem = req.body.rankingSystem || null;
    if (rankingSystem !== null && !['FIE', 'EFC', 'NATIONAL'].includes(rankingSystem)) fail('Type de classement invalide.');
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const lockMode = req.body.lockMode ?? 'FIRST_RESULT';
    if (!['TIME', 'FIRST_RESULT'].includes(lockMode)) fail('Mode de clôture invalide.');
    const source = lockMode === 'FIRST_RESULT' ? validateSource(req.body.sourceUrl, req.body.sourcePoolNumber) : {};
    const closesAt = lockMode === 'FIRST_RESULT' ? new Date() : new Date(req.body.closesAt);
    if (!name || name.length > 100) fail('Nom de poule requis (100 caractères maximum).');
    if (lockMode === 'TIME' && (typeof req.body.closesAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(req.body.closesAt)
      || !Number.isFinite(closesAt.getTime()) || closesAt <= new Date())) fail('Choisissez une clôture future avec un fuseau horaire.');
    if (!Array.isArray(req.body.fencers) || req.body.fencers.length < 2 || req.body.fencers.length > 8) fail('Une poule doit contenir de 2 à 8 tireurs.');
    const names = req.body.fencers.map(n => typeof n === 'string' ? n.trim() : '');
    if (names.some(n => !n || n.length > 100) || new Set(names.map(n => n.normalize('NFKC').toLowerCase())).size !== names.length) {
      fail('Chaque tireur doit avoir un nom distinct, de 1 à 100 caractères.');
    }
    if (!await db.competition.findUnique({ where: { id: competitionId } })) fail('Compétition introuvable.', 404);
    const pool = await db.pool.create({ data: { competitionId, name, closesAt, lockMode, rankingSystem, ...source,
      fencers: { create: names.map((name, index) => ({ name, position: index + 1 })) },
    }, include: { fencers: true } });
    res.status(201).json(pool);
  }));

  router.put('/:poolId/fencers/:fencerId/prediction', handle(async (req, res) => {
    const poolId = id(req.params.poolId);
    const fencerId = id(req.params.fencerId);
    const prediction = await withPool(poolId, async (tx, pool) => {
      const fencer = pool.fencers.find(f => f.id === fencerId);
      if (!fencer) fail('Tireur introuvable dans cette poule.', 404);
      if (fencerClosed(pool, fencer)) fail(sourceUnavailable(pool) && !fencer.firstResultAt && !closed(pool) ? 'Vérification FencingTimeLive en attente. Réessayez après le prochain contrôle.' : 'Les pronostics de ce tireur sont clos.', 409);
      const data = validatePrediction(req.body, pool.fencers.length);
      return tx.poolPrediction.upsert({
        where: { userId_fencerId: { userId: req.user.userId, fencerId } },
        create: { userId: req.user.userId, fencerId, ...data }, update: data,
      });
    });
    res.json(prediction);
  }));

  router.delete('/:poolId/fencers/:fencerId/prediction', handle(async (req, res) => {
    const poolId = id(req.params.poolId);
    const fencerId = id(req.params.fencerId);
    await withPool(poolId, async (tx, pool) => {
      const fencer = pool.fencers.find(f => f.id === fencerId);
      if (!fencer) fail('Tireur introuvable dans cette poule.', 404);
      if (fencerClosed(pool, fencer)) fail(sourceUnavailable(pool) && !fencer.firstResultAt && !closed(pool) ? 'Vérification FencingTimeLive en attente. Réessayez après le prochain contrôle.' : 'Les pronostics de ce tireur sont clos.', 409);
      await tx.poolPrediction.deleteMany({ where: { userId: req.user.userId, fencerId } });
    });
    res.status(204).end();
  }));

  router.post('/:poolId/close', admin, handle(async (req, res) => {
    await withPool(id(req.params.poolId), tx => tx.pool.update({ where: { id: id(req.params.poolId) }, data: { isLocked: true } }));
    res.json({ message: 'Pronostics clos.' });
  }));

  router.put('/:poolId/results', admin, handle(async (req, res) => {
    await withPool(id(req.params.poolId), async (tx, pool) => {
      if (!closed(pool)) fail('Fermez les pronostics avant de publier les résultats.', 409);
      const results = validateResults(req.body.results, pool.fencers);
      for (const { fencerId, ...data } of results) {
        await tx.poolFencer.update({ where: { id: fencerId }, data });
        const predictions = await tx.poolPrediction.findMany({ where: { fencerId } });
        for (const prediction of predictions) {
          await tx.poolPrediction.update({ where: { id: prediction.id }, data: { pointsEarned: poolPoints(prediction, data).total } });
        }
      }
      await tx.pool.update({ where: { id: pool.id }, data: { isLocked: true, isFinal: true } });
    });
    res.json({ message: 'Résultats publiés. Comparaisons et points recalculés.' });
  }));
  return router;
}
module.exports = createPoolRouter();
module.exports.createPoolRouter = createPoolRouter;
