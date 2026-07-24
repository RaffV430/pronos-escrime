// backend/src/routes/userRoutes.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Récupérer le classement des utilisateurs
router.get('/leaderboard', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        totalPoints: true,
      },
      orderBy: {
        totalPoints: 'desc',
      },
    });
    res.json(users);
  } catch (err) {
    console.error('Erreur leaderboard:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération du classement' });
  }
});

module.exports = router;