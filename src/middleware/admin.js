module.exports = function adminMiddleware(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Accès administrateur requis.' });
  }
  next();
};
