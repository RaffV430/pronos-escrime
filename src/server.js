const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
require('dotenv').config();

const prisma = require('./lib/prisma');
const { getAllowedOrigins, validateRuntimeConfig } = require('./config');
const authMiddleware = require('./middleware/auth');
const adminMiddleware = require('./middleware/admin');
const authRoutes = require('./routes/authRoutes');
const matchRoutes = require('./routes/matchRoutes');
const userRoutes = require('./routes/userRoutes');
const podiumRoutes = require('./routes/podiumRoutes');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || getAllowedOrigins().includes(origin)) return callback(null, true);
    return callback(new Error('Origine non autorisée par CORS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '100kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/users', userRoutes);
app.use('/api/podium', podiumRoutes);
app.use('/api/pools', require('./routes/poolRoutes'));

app.post('/api/admin/adjust-points', authMiddleware, adminMiddleware, async (req, res) => {
  let userId = req.body.userId ? Number(req.body.userId) : null;
  const name = String(req.body.name || '').normalize('NFC').trim();
  const points = Number(req.body.points);
  const tournamentId = req.body.tournamentId ? Number(req.body.tournamentId) : null;
  const competitionId = req.body.competitionId ? Number(req.body.competitionId) : null;
  const reason = String(req.body.reason || 'Ajustement manuel admin').trim().slice(0, 250);

  if ((!name && (!Number.isInteger(userId) || userId <= 0)) || (name && userId !== null) || !Number.isInteger(points) || Math.abs(points) > 10000) {
    return res.status(400).json({ error: "L'utilisateur et un nombre de points valide sont obligatoires." });
  }
  if ((tournamentId !== null && (!Number.isInteger(tournamentId) || tournamentId <= 0))
      || (competitionId !== null && (!Number.isInteger(competitionId) || competitionId <= 0))) {
    return res.status(400).json({ error: 'Tournoi ou compétition invalide.' });
  }

  try {
    const candidates = await prisma.user.findMany({ where: name ? { name: { equals: name, mode: 'insensitive' } } : { id: userId }, select: { id: true, name: true } });
    if (candidates.length > 1) return res.status(409).json({ error: 'Nom ambigu : utilisez l’ID du joueur.' });
    const user = candidates[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    userId = user.id;
    const adjustment = await prisma.pointAdjustment.create({
      data: { userId, points, reason, tournamentId, competitionId },
    });
    res.json({ success: true, adjustment, user });
  } catch (error) {
    console.error("Erreur lors de l'ajustement des points :", error);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de l'ajustement." });
  }
});

app.get('/api/tournaments', authMiddleware, async (req, res) => {
  try {
    const tournaments = await prisma.tournament.findMany({ orderBy: { createdAt: 'desc' } });
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
app.use((error, req, res, next) => {
  console.error('Erreur non gérée:', error);
  res.status(error.message?.includes('CORS') ? 403 : 500).json({ error: 'Erreur serveur.' });
});

function start() {
  validateRuntimeConfig();
  const port = Number(process.env.PORT) || 5000;
  const server = app.listen(port, () => console.log(`Serveur démarré sur le port ${port}`));

  const shutdown = async () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
