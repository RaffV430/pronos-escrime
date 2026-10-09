require('dotenv').config();
const { Sentry } = require('./instrument');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const prisma = require('./lib/prisma');
const { originAllowed, validateRuntimeConfig } = require('./config');
const authMiddleware = require('./middleware/auth');
const adminMiddleware = require('./middleware/admin');
const authRoutes = require('./routes/authRoutes');
const matchRoutes = require('./routes/matchRoutes');
const podiumRoutes = require('./routes/podiumRoutes');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || originAllowed(origin)) return callback(null, true);
      return callback(new Error('Origine non autorisée par CORS.'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json({ limit: '100kb' }));

// Limite générale : 300 requêtes/min par session (ou par adresse IP sans session). Protège la base
// contre un compte ou un script qui boucle, sans gêner un club entier derrière le même wifi.
const { rateLimit } = require('express-rate-limit');
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Trop de requêtes. Patientez une minute.' },
    keyGenerator: require('./middleware/rateIdentity').rateIdentity,
  }),
);

// Une écriture réussie qui peut modifier des points vide le cache du classement (voir standings.js).
app.use((req, res, next) => {
  const standings = require('./services/standings');
  if (standings.changesPoints(req.method, req.path))
    res.on('finish', () => {
      if (res.statusCode < 400) standings.invalidateStandings();
    });
  next();
});

// Les limites anti-abus de connexion sont dans authRoutes (par identifiant, échecs seulement).
app.use('/api/auth', authRoutes);
app.use('/api/clubs', require('./routes/accountClubRoutes').createRouter(prisma));
app.use('/api/matches', matchRoutes);
app.use('/api/podium', podiumRoutes);
app.use('/api/pools', require('./routes/poolRoutes'));

app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/fencer-affiliations', require('./routes/fencerAffiliationRoutes').createRouter(prisma));
app.use('/api/community', require('./routes/communityRoutes'));
app.use('/api/me/fencers', require('./routes/fencerFollowRoutes').createRouter(prisma));
app.use('/api/me', require('./routes/personalRoutes'));
app.use('/api/results', require('./routes/resultsRoutes'));
// Page publique d'un tournoi (sans compte).
app.use('/api/public', require('./routes/publicRoutes'));

app.get('/api/tournaments', authMiddleware, async (req, res) => {
  try {
    const tournaments = await prisma.tournament.findMany({
      where: req.query.active === 'true' ? { archivedAt: null } : {},
      orderBy: { createdAt: 'desc' },
    });
    res.json(tournaments);
  } catch (error) {
    console.error('Erreur récupération tournois:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/', (req, res) => res.json({ message: '🤺 API MPP Escrime opérationnelle !' }));
app.get('/health', async (req, res) => {
  const workers = require('./services/workerHealth').workerHealth();
  const uptime = Math.round(process.uptime());
  // Juste après le démarrage, aucune tâche n'a encore eu le temps de passer.
  const stale = uptime > 120 && Object.values(workers).some((w) => w.stale);
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: stale ? 'degraded' : 'ok', database: 'connected', workers, uptime });
  } catch (error) {
    res.status(503).json({ status: 'degraded', database: 'unavailable', workers, uptime });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable.' }));
// Les erreurs de saisie ne sont pas des pannes et peuvent contenir un mot de passe dans error.body.
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
  next(error);
});
if (Sentry) Sentry.setupExpressErrorHandler(app);
app.use((error, req, res, next) => {
  console.error('Erreur non gérée:', error);
  res.status(error.message?.includes('CORS') ? 403 : 500).json({ error: 'Erreur serveur.' });
});

async function start() {
  validateRuntimeConfig();
  // Refuse de démarrer si la base ne contient pas toutes les colonnes du schéma
  // (SKIP_SCHEMA_CHECK=true pour désactiver en cas d'urgence).
  // Applique d'abord les migrations automatiques de prisma/auto/ (SKIP_AUTO_MIGRATIONS=true pour désactiver).
  if (process.env.SKIP_AUTO_MIGRATIONS !== 'true') {
    const { applied, total } = await require('./services/migrations').runMigrations(prisma);
    console.log(`Migrations : ${applied.length} appliquée(s), ${total} au total.`);
  }
  if (process.env.SKIP_SCHEMA_CHECK !== 'true') {
    const { tables } = await require('./services/schemaCheck').checkSchema(prisma);
    console.log(`Schéma de la base vérifié (${tables} tables).`);
  }
  await require('./services/ffeRankingImport').run(prisma);
  const port = Number(process.env.PORT) || 5000;
  const server = app.listen(port, () => console.log(`Serveur démarré sur le port ${port}`));

  const stopNotifications = require('./services/pushNotifications').startWorker(prisma);
  const stopFtl = require('./services/ftlScheduler').startWorker(prisma);
  const stopMaintenance = require('./services/maintenance').startWorker(prisma);
  const stopWatchdog = require('./services/workerHealth').startWatchdog();
  const stopCalendar = require('./services/calendarWatch').startWorker(prisma);
  // Arrêt propre (redéploiement Render) : plus de nouvelles requêtes ni de nouveaux passages,
  // on attend la fin des passages en cours (25 s au plus), puis on ferme la base.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(0), 25000);
    force.unref();
    server.close();
    stopWatchdog();
    await Promise.allSettled([stopFtl(), stopNotifications(), stopMaintenance(), stopCalendar()]);
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module)
  start().catch(async (error) => {
    console.error('Démarrage annulé :', error.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });

module.exports = { app, start };
