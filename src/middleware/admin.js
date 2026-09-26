const prisma = require('../lib/prisma');

function createAdminMiddleware(db = prisma) {
return async function adminMiddleware(req, res, next) {
  const userId = req.user?.userId;
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({ error: 'Session invalide.' });
  }
  try {
    // A session claim can predate a promotion or revocation of admin rights.
    const user = await db.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!user?.isAdmin) {
      return res.status(403).json({ error: 'Accès administrateur requis.' });
    }
    req.user.isAdmin = true;
    next();
  } catch (error) {
    next(error);
  }
};
}
module.exports = createAdminMiddleware();
module.exports.createAdminMiddleware = createAdminMiddleware;
