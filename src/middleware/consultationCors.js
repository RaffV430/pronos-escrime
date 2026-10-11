// Permit conditional GETs without exposing any account-specific header.
module.exports = {
  allowedHeaders: ['Content-Type', 'Authorization', 'If-None-Match'],
  exposedHeaders: ['ETag'],
  // Le navigateur garde l'autorisation 10 min : plus de requête préalable avant chaque rafraîchissement.
  maxAge: 600,
};
