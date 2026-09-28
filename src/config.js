function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`La variable d'environnement ${name} est obligatoire.`);
  }
  return value;
}

function getJwtSecret() {
  return requiredEnv('JWT_SECRET');
}

function getAllowedOrigins() {
  const configured = process.env.CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured?.length) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error("La variable d'environnement CORS_ORIGINS est obligatoire en production.");
  }
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

// Une entrée de CORS_ORIGINS peut contenir « * » pour un seul segment de nom
// (ex. https://pronos-escrime-*.vercel.app pour les prévisualisations Vercel du staging).
function originAllowed(origin, allowed = getAllowedOrigins()) {
  return allowed.some((entry) => {
    if (!entry.includes('*')) return entry === origin;
    const pattern = entry
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[a-z0-9-]+');
    return new RegExp(`^${pattern}$`, 'i').test(origin);
  });
}

function validateRuntimeConfig() {
  requiredEnv('DATABASE_URL');
  getJwtSecret();
  getAllowedOrigins();
}

module.exports = { getAllowedOrigins, originAllowed, getJwtSecret, validateRuntimeConfig };
