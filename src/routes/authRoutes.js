const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');

const authMiddleware = require('../middleware/auth');
const session = require('../services/session');
const { rateLimit } = require('express-rate-limit');

// Limites anti-abus pensées pour une salle d'armes : tous les joueurs y partagent
// souvent la même adresse IP (wifi du club). On ne compte donc que les échecs,
// par identifiant visé, avec un plafond par IP beaucoup plus large.
const tooMany = { error: 'Trop de tentatives. Réessayez dans quelques minutes.' };
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync('pronos-escrime-compte-inexistant', BCRYPT_COST);
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
// Actions sensibles d'un compte connecté (suppression, 2FA, mot de passe) : 5 échecs / 15 min par compte.
const passwordChecksPerUser = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `user:${req.user?.userId}`,
});

// ---------------------------------------------------------
// 2. Route GET /api/auth/me (Vérification de la session)
// ---------------------------------------------------------
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, email: true, isAdmin: true, totpEnabledAt: true },
    });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    // On renvoie 'username' pour le frontend qui attend cette variable
    const { totpEnabledAt, ...rest } = user;
    res.json({ ...rest, username: user.name, twoFactorEnabled: Boolean(totpEnabledAt) });
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

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);

    const newUser = await prisma.user.create({
      data: {
        email,
        name: nameToSave, // On enregistre dans la colonne 'name'
        password: hashedPassword,
      },
    });

    const token = session.issueToken(newUser);

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
// Double authentification (TOTP) — réservée aux administrateurs
// ---------------------------------------------------------
const totp = require('../services/totp');
async function consumeTotp(user, code) {
  let secret;
  try {
    secret = totp.openSecret(user.totpSecret);
  } catch {
    return false;
  }
  const step = totp.verifyCode(secret, code, { lastStep: user.totpLastStep ?? null });
  if (step === null) return false;
  // Enregistre le pas utilisé : un même code ne peut pas servir deux fois.
  const saved = await prisma.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return saved.count === 1;
}
const twoFactorLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 20 });

router.post('/2fa/setup', authMiddleware, twoFactorLimiter, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
    if (user.totpEnabledAt) return res.status(409).json({ error: 'La double authentification est déjà active.' });
    const secret = totp.generateSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: totp.sealSecret(secret), totpEnabledAt: null, totpLastStep: null },
    });
    res.json({ secret, otpauthUrl: totp.otpauthUrl(secret, user.email) });
  } catch (err) {
    console.error('Erreur 2FA setup:', err);
    res.status(500).json({ error: 'Préparation impossible. Réessayez.' });
  }
});

router.post('/2fa/enable', authMiddleware, twoFactorLimiter, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.isAdmin) return res.status(403).json({ error: 'Réservé aux administrateurs.' });
    if (!user.totpSecret || user.totpEnabledAt)
      return res.status(409).json({ error: 'Recommencez la configuration de la double authentification.' });
    if (!(await consumeTotp(user, req.body.code)))
      return res.status(400).json({ error: 'Code incorrect. Vérifiez l’heure de votre téléphone et réessayez.' });
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabledAt: new Date() } });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: 'Activation double authentification', targetType: 'User', targetId: user.id },
    });
    res.json({ enabled: true });
  } catch (err) {
    console.error('Erreur 2FA enable:', err);
    res.status(500).json({ error: 'Activation impossible. Réessayez.' });
  }
});

router.post('/2fa/disable', authMiddleware, passwordChecksPerUser, twoFactorLimiter, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.totpEnabledAt) return res.status(409).json({ error: 'La double authentification n’est pas active.' });
    if (!(await bcrypt.compare(String(req.body.password || ''), user.password)))
      return res.status(400).json({ error: 'Mot de passe incorrect.' });
    if (!(await consumeTotp(user, req.body.code))) return res.status(400).json({ error: 'Code incorrect.' });
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'Désactivation double authentification',
        targetType: 'User',
        targetId: user.id,
      },
    });
    res.json({ enabled: false });
  } catch (err) {
    console.error('Erreur 2FA disable:', err);
    res.status(500).json({ error: 'Désactivation impossible. Réessayez.' });
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

    // Comparaison toujours effectuée (avec une empreinte factice si besoin) : le temps de
    // réponse ne révèle pas si le compte existe.
    const validPassword = await bcrypt.compare(password, user?.password || DUMMY_HASH);
    if (!user || !user.password || !validPassword) {
      return res.status(400).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    // Empreintes anciennes (coût 10) renforcées à la première connexion réussie.
    if (bcrypt.getRounds(user.password) < BCRYPT_COST) {
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { password: await bcrypt.hash(password, BCRYPT_COST) },
        });
      } catch {
        // Renforcement retenté à la prochaine connexion.
      }
    }

    // Double authentification : un code à 6 chiffres est exigé après le mot de passe.
    if (user.totpEnabledAt) {
      if (!req.body.code)
        return res
          .status(401)
          .json({ twoFactorRequired: true, error: 'Saisissez le code de votre application d’authentification.' });
      if (!(await consumeTotp(user, req.body.code)))
        return res
          .status(400)
          .json({ twoFactorRequired: true, error: 'Code de vérification incorrect ou déjà utilisé.' });
    }

    const token = session.issueToken(user);

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
const { sendMail } = require('../services/mailer');
const account = require('../services/account');
const forgotPerIp = limiter({ windowMs: 15 * 60 * 1000, limit: 10 });
const forgotPerEmail = limiter({ windowMs: 60 * 60 * 1000, limit: 3, keyGenerator: identifierKey });
const resetPerIp = limiter({ windowMs: 15 * 60 * 1000, limit: 20 });
const validPassword = (password) => typeof password === 'string' && password.length >= 10 && password.length <= 128;

router.get('/config', (req, res) => res.json({ passwordReset: require('../services/mailer').playerMailAvailable() }));

router.post('/forgot-password', forgotPerIp, forgotPerEmail, async (req, res) => {
  // Réponse identique que le compte existe ou non : on ne révèle pas les adresses inscrites.
  const done = () =>
    res.json({
      message: 'Si un compte correspond à cette adresse, un e-mail de réinitialisation vient d’être envoyé.',
    });
  if (!require('../services/mailer').playerMailAvailable())
    return res.status(503).json({ error: 'La réinitialisation par e-mail n’est pas encore disponible.' });
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    // Même réponse, au même moment, que le compte existe ou non ; l'envoi se fait ensuite.
    done();
    if (user)
      sendMail(account.resetEmail(user, account.createResetToken(user))).catch((err) =>
        console.error('Erreur mot de passe oublié :', err.message),
      );
  } catch (err) {
    console.error('Erreur mot de passe oublié :', err.message);
    if (!res.headersSent) done();
  }
});

router.post('/reset-password', resetPerIp, async (req, res) => {
  const { token, password } = req.body;
  if (!validPassword(password))
    return res.status(400).json({ error: 'Le mot de passe doit contenir entre 10 et 128 caractères.' });
  try {
    const user = await account.verifyResetToken(prisma, token);
    if (!user) return res.status(400).json({ error: 'Ce lien a expiré ou a déjà servi. Refaites une demande.' });
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(password, BCRYPT_COST) } });
    // Toutes les sessions ouvertes avec l'ancien mot de passe sont coupées.
    await session.revokeSessions(prisma, user.id);
    res.json({ message: 'Mot de passe modifié. Vous pouvez vous connecter.' });
  } catch (err) {
    console.error('Erreur réinitialisation:', err);
    res.status(500).json({ error: 'Réinitialisation impossible. Réessayez.' });
  }
});

router.delete('/account', authMiddleware, passwordChecksPerUser, async (req, res) => {
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

// ---------------------------------------------------------
// Sessions : renouvellement, changement de mot de passe, déconnexion des autres appareils
// ---------------------------------------------------------
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(401).json({ error: 'Session expirée.' });
    res.json({ token: session.issueToken(user, { since: session.sessionStart(req.user) }) });
  } catch (err) {
    console.error('Erreur refresh:', err);
    res.status(500).json({ error: 'Renouvellement impossible.' });
  }
});

router.post('/change-password', authMiddleware, passwordChecksPerUser, loginPerIp, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!validPassword(newPassword))
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir entre 10 et 128 caractères.' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user || !(await bcrypt.compare(String(currentPassword || ''), user.password)))
      return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
    await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(newPassword, BCRYPT_COST) },
    });
    const updated = await session.revokeSessions(prisma, user.id);
    res.json({
      message: 'Mot de passe modifié. Vos autres appareils ont été déconnectés.',
      token: session.issueToken(updated),
    });
  } catch (err) {
    console.error('Erreur changement de mot de passe:', err);
    res.status(500).json({ error: 'Modification impossible. Réessayez.' });
  }
});

router.post('/logout-others', authMiddleware, async (req, res) => {
  try {
    const updated = await session.revokeSessions(prisma, req.user.userId);
    res.json({ message: 'Vos autres appareils ont été déconnectés.', token: session.issueToken(updated) });
  } catch (err) {
    console.error('Erreur déconnexion des appareils:', err);
    res.status(500).json({ error: 'Déconnexion impossible. Réessayez.' });
  }
});

module.exports = router;
