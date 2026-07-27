const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Ajout de Prisma pour la route d'ajustement manuel
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 1. Imports des routes
const authRoutes = require('./routes/authRoutes');
const matchRoutes = require('./routes/matchRoutes');
const userRoutes = require('./routes/userRoutes');
const podiumRoutes = require('./routes/podiumRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// 2. Middlewares globaux
app.use(cors());
app.use(express.json());

// 3. Déclaration des routes API
app.use('/api/auth', authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/users', userRoutes);
app.use('/api/podium', podiumRoutes);

// ==========================================
// ROUTE : AJUSTEMENT MANUEL DES POINTS
// ==========================================
app.post('/api/admin/adjust-points', async (req, res) => {
  try {
    const { userId, points, reason, tournamentId, competitionId } = req.body;

    if (!userId || points === undefined) {
      return res.status(400).json({ error: "L'ID du joueur et les points sont obligatoires." });
    }

    const adjustment = await prisma.pointAdjustment.create({
      data: {
        userId: parseInt(userId, 10),
        points: parseInt(points, 10),
        reason: reason || "Ajustement manuel admin",
        tournamentId: tournamentId ? parseInt(tournamentId, 10) : null,
        competitionId: competitionId ? parseInt(competitionId, 10) : null,
      },
    });

    res.status(200).json({ success: true, adjustment });
  } catch (error) {
    console.error("❌ Erreur lors de l'ajustement des points :", error);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de l'ajustement." });
  }
});
// ==========================================

// ROUTE POUR RÉCUPÉRER LA LISTE DES TOURNOIS
app.get('/api/tournaments', async (req, res) => {
  try {
    const tournaments = await prisma.tournament.findMany();
    res.json(tournaments);
  } catch (error) {
    console.error('Erreur récupération tournois:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// Route de test de santé
app.get('/', (req, res) => {
  res.json({ message: '🤺 API MPP Escrime opérationnelle !' });
});

// 4. Lancement du serveur (TOUJOURS À LA FIN)
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});