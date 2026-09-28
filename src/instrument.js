// Suivi des erreurs (Sentry), actif uniquement si SENTRY_DSN est défini.
// Chargé en tout premier par server.js. Sans DSN, ce fichier ne fait rien.
const dsn = process.env.SENTRY_DSN?.trim();
let Sentry = null;

if (dsn) {
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  // Les routes attrapent leurs erreurs et les journalisent avec console.error :
  // on transmet aussi à Sentry toute erreur passée à console.error.
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    const error = args.find((a) => a instanceof Error);
    if (error)
      Sentry.captureException(error, { extra: { message: args.filter((a) => typeof a === 'string').join(' ') } });
  };
}

module.exports = { Sentry };
