// Permit conditional GETs without exposing any account-specific header.
module.exports = {
  allowedHeaders: ['Content-Type', 'Authorization', 'If-None-Match'],
  exposedHeaders: ['ETag'],
};
