// Sessions de 30 jours, renouvelées à l'usage, et révocables.
// Chaque compte a une « version de session » : l'augmenter (changement ou
// réinitialisation du mot de passe, « déconnecter mes autres appareils »)
// invalide immédiatement tous les jetons émis avant.
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config');

const SESSION_TTL = '30d';
const CACHE_MS = 30000;
const cache = new Map(); // userId → { version, at }

// Une session renouvelée garde sa date d'ouverture (« s0 ») : au-delà de 90 jours, reconnexion obligatoire.
const MAX_SESSION_SECONDS = 90 * 24 * 3600;
const sessionStart = (claims) => (Number.isSafeInteger(claims?.s0) ? claims.s0 : claims?.iat);
function issueToken(user, { since } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { userId: user.id, isAdmin: user.isAdmin, sv: user.sessionVersion ?? 0, s0: since ?? now },
    getJwtSecret(),
    { expiresIn: SESSION_TTL, algorithm: 'HS256' },
  );
}
function sessionTooOld(claims, now = Math.floor(Date.now() / 1000)) {
  const start = sessionStart(claims);
  return Number.isSafeInteger(start) && now - start > MAX_SESSION_SECONDS;
}

// Version actuelle (mise en cache 30 s pour ne pas interroger la base à chaque requête).
async function currentVersion(db, userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.version;
  const user = await db.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
  const version = user ? (user.sessionVersion ?? 0) : null; // null : compte supprimé
  cache.set(userId, { version, at: Date.now() });
  return version;
}

async function revokeSessions(db, userId) {
  const user = await db.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
  cache.delete(userId);
  return user;
}

const forget = (userId) => cache.delete(userId);

module.exports = { issueToken, currentVersion, revokeSessions, forget, sessionStart, sessionTooOld, SESSION_TTL };
