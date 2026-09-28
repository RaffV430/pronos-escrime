const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config');

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
    if (decoded.sv !== undefined) {
      const version = await require('../services/session').currentVersion(require('../lib/prisma'), decoded.userId);
      if (version === null || version !== decoded.sv) throw new Error('Session révoquée');
    }
    req.user = decoded;
  } catch (ex) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
  next();
};
