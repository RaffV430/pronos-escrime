// Réinitialisation du mot de passe et suppression de compte.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config');

const RESET_PURPOSE = 'password-reset';
const RESET_TTL = '30m';

// Empreinte du mot de passe actuel : le lien devient invalide dès que le mot de
// passe change (donc après usage), sans table supplémentaire en base.
const passwordStamp = (hash) => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 24);

function createResetToken(user) {
  return jwt.sign({ sub: user.id, purpose: RESET_PURPOSE, stamp: passwordStamp(user.password) }, getJwtSecret(), {
    expiresIn: RESET_TTL,
    algorithm: 'HS256',
  });
}

// Renvoie l'identifiant de l'utilisateur si le jeton est valide pour son mot de passe actuel.
async function verifyResetToken(db, token) {
  let payload;
  try {
    payload = jwt.verify(String(token || ''), getJwtSecret(), { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  if (payload.purpose !== RESET_PURPOSE || !Number.isSafeInteger(payload.sub)) return null;
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || passwordStamp(user.password) !== payload.stamp) return null;
  return user;
}

function appUrl() {
  const configured = process.env.APP_URL?.trim() || process.env.CORS_ORIGINS?.split(',')[0]?.trim();
  return (configured || 'https://pronos-escrime.vercel.app').replace(/\/$/, '');
}

function resetEmail(user, token) {
  const link = `${appUrl()}/?reset=${encodeURIComponent(token)}`;
  const text = `Bonjour ${user.name},

Vous avez demandé à réinitialiser votre mot de passe Pronos Escrime.
Ouvrez ce lien dans les 30 minutes pour choisir un nouveau mot de passe :
${link}

Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.`;
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<p>Bonjour ${escape(user.name)},</p>
<p>Vous avez demandé à réinitialiser votre mot de passe Pronos Escrime.</p>
<p><a href="${escape(link)}">Choisir un nouveau mot de passe</a> (lien valable 30 minutes).</p>
<p>Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.</p>`;
  return { to: user.email, subject: 'Réinitialisation de votre mot de passe Pronos Escrime', text, html };
}

// Supprime le compte et tout ce qui s'y rattache. Les pronostics, podiums, poules,
// ajustements et abonnements aux notifications partent en cascade (schéma Prisma) ;
// les tables sans relation déclarée sont traitées ici. Les ligues créées par le
// joueur sont confiées au plus ancien membre restant, ou supprimées si elles sont vides.
async function deleteAccount(tx, userId) {
  await tx.challengePick.deleteMany({ where: { userId } });
  await tx.leagueMember.deleteMany({ where: { userId } });
  const owned = await tx.league.findMany({ where: { ownerId: userId } });
  for (const league of owned) {
    const heir = await tx.leagueMember.findFirst({ where: { leagueId: league.id }, orderBy: { joinedAt: 'asc' } });
    if (heir) await tx.league.update({ where: { id: league.id }, data: { ownerId: heir.userId } });
    else await tx.league.delete({ where: { id: league.id } });
  }
  await tx.user.delete({ where: { id: userId } });
  return { transferredLeagues: owned.length };
}

module.exports = { createResetToken, verifyResetToken, resetEmail, deleteAccount, passwordStamp, appUrl };
