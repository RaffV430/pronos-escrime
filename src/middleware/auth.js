const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config');
const LEGACY_TOKENS_EXPIRED = Date.parse('2026-09-30T00:00:00Z');

module.exports = async function (req, res, next) {
  const authHeader = req.header('Authorization');

  if (!authHeader) {
    return res.status(401).json({ error: 'Accès refusé. Aucun token fourni.' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Format du token invalide.' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    // Seuls les jetons de session sont acceptés : un jeton à usage spécial (ex.
    // réinitialisation du mot de passe) ou sans identifiant valide est refusé.
    if (!Number.isSafeInteger(decoded.userId) || decoded.userId <= 0 || decoded.purpose)
      throw new Error('Jeton non valable');
    // Jetons récents : la version de session doit correspondre à celle du compte
    // (sinon le mot de passe a changé, les sessions ont été coupées, ou le compte supprimé).
    // Les anciens jetons sans version (24 h, émis avant le 28/09/2026 22h) ont tous expiré
    // depuis : après cette date, un jeton sans version est refusé.
    const session = require('../services/session');
    if (decoded.sv === undefined) {
      if (Date.now() > LEGACY_TOKENS_EXPIRED) throw new Error('Jeton sans version');
    } else {
      const version = await session.currentVersion(require('../lib/prisma'), decoded.userId);
      if (version === null || version !== decoded.sv) throw new Error('Session révoquée');
    }
    if (session.sessionTooOld(decoded)) throw new Error('Session trop ancienne');
    req.user = decoded;
  } catch (ex) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
  next();
};
