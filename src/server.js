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
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Trop de requêtes. Patientez une minute.' },
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth
        ? `s:${require('node:crypto').createHash('sha256').update(auth).digest('base64url').slice(0, 22)}`
        : `ip:${ipKeyGenerator(req.ip || '')}`;
    },
  }),
);

// Toute écriture réussie peut modifier les points : le classement mis en cache est invalidé.
app.use((req, res, next) => {
  if (req.method !== 'GET')
    res.on('finish', () => {
      if (res.statusCode < 400) require('./services/standings').invalidateStandings();
    });
  next();
});

// Les limites anti-abus de connexion sont dans authRoutes (par identifiant, échecs seulement).
app.use('/api/auth', authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/podium', podiumRoutes);
app.use('/api/pools', require('./routes/poolRoutes'));

app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/community', require('./routes/communityRoutes'));
app.use('/api/me', require('./routes/personalRoutes'));

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
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable.' }));
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
  const port = Number(process.env.PORT) || 5000;
  const server = app.listen(port, () => console.log(`Serveur démarré sur le port ${port}`));

  const stopNotifications = require('./services/pushNotifications').startWorker(prisma);
  const stopFtl = require('./services/ftlScheduler').startWorker(prisma);
  const shutdown = async () => {
    stopFtl();
    stopNotifications();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
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
