// Signale une erreur inattendue (jamais une erreur prévue, qui porte un `status`) :
// une ligne courte dans le journal Render, sans données, et l'erreur complète dans Sentry si configuré.
function reportError(error, where, extra = {}) {
  if (error?.status) return; // erreur prévue (message déjà adapté au joueur)
  const { Sentry } = require('../instrument');
  // Chaînes seulement : le relais console.error → Sentry ne la capture pas une seconde fois.
  console.error(`Erreur inattendue (${where}) :`, String(error?.code || ''), String(error?.message || error));
  if (Sentry)
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { where }, extra });
}

module.exports = { reportError };
