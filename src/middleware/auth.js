const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config');

module.exports = function (req, res, next) {
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
    req.user = decoded;
    next();
  } catch (ex) {
    res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
};
