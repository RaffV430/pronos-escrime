const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const authMiddleware = require('../middleware/auth');

// ---------------------------------------------------------
// 2. Route GET /api/auth/me (Vérification de la session)
// ---------------------------------------------------------
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, email: true, isAdmin: true, totalPoints: true } // On sélectionne bien 'name' ici
    });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    
    // On renvoie 'username' pour le frontend qui attend cette variable
    res.json({ ...user, username: user.name });
  } catch (err) {
    console.error('Erreur /me:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---------------------------------------------------------
// 3. Route POST /api/auth/register (Inscription)
// ---------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email/Identifiant et mot de passe requis.' });
    }

    const nameToSave = username || email.split('@')[0];

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: email }, { name: nameToSave }] // On cherche dans 'name'
      }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Cet identifiant ou e-mail est déjà utilisé.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        email,
        name: nameToSave, // On enregistre dans la colonne 'name'
        password: hashedPassword,
      },
    });

    const token = jwt.sign(
      { userId: newUser.id, isAdmin: newUser.isAdmin },
      process.env.JWT_SECRET || 'supersecretkey',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { id: newUser.id, username: newUser.name, email: newUser.email, isAdmin: newUser.isAdmin },
    });
  } catch (err) {
    console.error('Erreur Register:', err);
    res.status(500).json({ error: "Erreur lors de l'inscription." });
  }
});

// ---------------------------------------------------------
// 4. Route POST /api/auth/login (Connexion)
// ---------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }

    // 🛡️ On cherche dans la colonne 'email' OU dans la colonne 'name' (selon pgAdmin)
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email },
          { name: email }
        ]
      }
    });

    if (!user || !user.password) {
      return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    const token = jwt.sign(
      { userId: user.id, isAdmin: user.isAdmin },
      process.env.JWT_SECRET || 'supersecretkey',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.name, email: user.email, isAdmin: user.isAdmin },
    });
  } catch (err) {
    console.error('Erreur Login:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

module.exports = router;