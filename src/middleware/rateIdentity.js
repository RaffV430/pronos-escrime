const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config');
const { ipKeyGenerator } = require('express-rate-limit');
function rateIdentity(req) {
  const token = /^Bearer ([^ ]+)$/.exec(req.headers.authorization || '')?.[1];
  if (token)
    try {
      const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
      if (
        Number.isSafeInteger(decoded.userId) &&
        decoded.userId > 0 &&
        !decoded.purpose &&
        Number.isSafeInteger(decoded.sv)
      )
        return `user:${decoded.userId}`;
    } catch {
      /* Une fausse session reste dans le quota de son adresse IP. */
    }
  return `ip:${ipKeyGenerator(req.ip || '')}`;
}
module.exports = { rateIdentity };
