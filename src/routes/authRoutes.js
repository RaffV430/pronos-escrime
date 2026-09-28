const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { getJwtSecret } = require('../config');

const authMiddleware = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');

// Limites anti-abus pensées pour une salle d'armes : tous les joueurs y partagent
// souvent la même adresse IP (wifi du club). On ne compte donc que les échecs,
// par identifiant visé, avec un plafond par IP beaucoup plus large.
const tooMany = { error: 'Trop de tentatives. Réessayez dans quelques minutes.' };
const limiter = (options) =>
  rateLimit({ standardHeaders: 'draft-8', legacyHeaders: false, message: tooMany, ...options });
const identifierKey = (req) =>
  'id:' +
  String(req.body?.email || '')
    .trim()
    .toLowerCase()
    .slice(0, 200);
const loginPerIdentifier = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: identifierKey,
});
const loginPerIp = limiter({ windowMs: 15 * 60 * 1000, limit: 200, skipSuccessfulRequests: true });
const registerPerIp = limiter({ windowMs: 60 * 60 * 1000, limit: 60 });

// ---------------------------------------------------------
// 2. Route GET /api/auth/me (Vérification de la session)
// ---------------------------------------------------------
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, email: true, isAdmin: true }, // On sélectionne bien 'name' ici
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
router.post('/register', registerPerIp, async (req, res) => {
  try {
    const username = String(req.body.username || '')
      .normalize('NFC')
      .trim();
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
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
    if (nameToSave.includes('@')) {
      return res.status(400).json({ error: 'Le nom d’utilisateur ne peut pas contenir « @ ».' });
    }

    // Le nom ne doit correspondre ni à un nom ni à l'e-mail d'un compte existant.
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: email, mode: 'insensitive' } },
          { name: { equals: nameToSave, mode: 'insensitive' } },
          { email: { equals: nameToSave, mode: 'insensitive' } },
          { name: { equals: email, mode: 'insensitive' } },
        ],
      },
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

    const token = jwt.sign({ userId: newUser.id, isAdmin: newUser.isAdmin }, getJwtSecret(), { expiresIn: '24h' });

    res.json({
      token,
      user: { id: newUser.id, username: newUser.name, email: newUser.email, isAdmin: newUser.isAdmin },
    });
  } catch (err) {
    if (err.code === 'P2002')
      return res.status(409).json({ error: 'Ce nom ou cette adresse e-mail est déjà utilisé.' });
    console.error('Erreur Register:', err);
    res.status(500).json({ error: "Erreur lors de l'inscription." });
  }
});

// ---------------------------------------------------------
// 4. Route POST /api/auth/login (Connexion)
// ---------------------------------------------------------
router.post('/login', loginPerIp, loginPerIdentifier, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }

    // Un identifiant avec « @ » désigne d'abord une adresse e-mail : un nom
    // d'utilisateur identique à l'e-mail d'un autre joueur ne peut plus
    // intercepter sa connexion. Repli sur le nom pour les anciens comptes dont
    // le nom contient « @ ».
    let user = email.includes('@') ? await prisma.user.findUnique({ where: { email: email.toLowerCase() } }) : null;
    if (!user) user = await prisma.user.findFirst({ where: { name: email } });

    if (!user || !user.password) {
      return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    const token = jwt.sign({ userId: user.id, isAdmin: user.isAdmin }, getJwtSecret(), { expiresIn: '24h' });

    res.json({
      token,
      user: { id: user.id, username: user.name, email: user.email, isAdmin: user.isAdmin },
    });
  } catch (err) {
    console.error('Erreur Login:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

// ---------------------------------------------------------
// Mot de passe oublié / réinitialisation / suppression de compte
// ---------------------------------------------------------
const { mailConfigured, sendMail } = require('../services/mailer');
const account = require('../services/account');
const forgotPerIp = limiter({ windowMs: 15 * 60 * 1000, limit: 10 });
const forgotPerEmail = limiter({ windowMs: 60 * 60 * 1000, limit: 3, keyGenerator: identifierKey });
const resetPerIp = limiter({ windowMs: 15 * 60 * 1000, limit: 20 });
const validPassword = (password) => typeof password === 'string' && password.length >= 10 && password.length <= 128;

router.get('/config', (req, res) => res.json({ passwordReset: mailConfigured() }));

router.post('/forgot-password', forgotPerIp, forgotPerEmail, async (req, res) => {
  // Réponse identique que le compte existe ou non : on ne révèle pas les adresses inscrites.
  const done = () =>
    res.json({
      message: 'Si un compte correspond à cette adresse, un e-mail de réinitialisation vient d’être envoyé.',
    });
  if (!mailConfigured())
    return res.status(503).json({ error: 'La réinitialisation par e-mail n’est pas encore disponible.' });
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) await sendMail(account.resetEmail(user, account.createResetToken(user)));
    done();
  } catch (err) {
    console.error('Erreur mot de passe oublié:', err);
    res.status(502).json({ error: 'L’e-mail n’a pas pu être envoyé. Réessayez dans quelques minutes.' });
  }
});

router.post('/reset-password', resetPerIp, async (req, res) => {
  const { token, password } = req.body;
  if (!validPassword(password))
    return res.status(400).json({ error: 'Le mot de passe doit contenir entre 10 et 128 caractères.' });
  try {
    const user = await account.verifyResetToken(prisma, token);
    if (!user) return res.status(400).json({ error: 'Ce lien a expiré ou a déjà servi. Refaites une demande.' });
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(password, 10) } });
    res.json({ message: 'Mot de passe modifié. Vous pouvez vous connecter.' });
  } catch (err) {
    console.error('Erreur réinitialisation:', err);
    res.status(500).json({ error: 'Réinitialisation impossible. Réessayez.' });
  }
});

router.delete('/account', authMiddleware, async (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== 'SUPPRIMER' || typeof password !== 'string')
    return res.status(400).json({ error: 'Saisissez votre mot de passe et tapez SUPPRIMER pour confirmer.' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (user.isAdmin)
      return res
        .status(409)
        .json({ error: 'Un compte administrateur ne peut pas être supprimé ici. Retirez d’abord ses droits.' });
    if (!(await bcrypt.compare(password, user.password)))
      return res.status(400).json({ error: 'Mot de passe incorrect.' });
    await prisma.$transaction((tx) => account.deleteAccount(tx, user.id));
    res.json({ message: 'Votre compte et vos données ont été supprimés.' });
  } catch (err) {
    console.error('Erreur suppression de compte:', err);
    res.status(500).json({ error: 'Suppression impossible. Réessayez.' });
  }
});

module.exports = router;
