const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { getJwtSecret } = require('../config');

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
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email/Identifiant et mot de passe requis.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    }
    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir entre 10 et 128 caractères.' });
    }

    const nameToSave = username || email.split('@')[0];
    if (nameToSave.length < 2 || nameToSave.length > 40) {
      return res.status(400).json({ error: 'Le nom doit contenir entre 2 et 40 caractères.' });
    }

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
      getJwtSecret(),
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
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }

    // 🛡️ On cherche dans la colonne 'email' OU dans la colonne 'name' (selon pgAdmin)
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
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
      getJwtSecret(),
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
