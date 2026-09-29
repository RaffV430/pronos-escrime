// Envoi d'e-mails transactionnels via l'API HTTP de Resend.
// Actif uniquement si RESEND_API_KEY et MAIL_FROM sont définis.
const axios = require('axios');

function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.MAIL_FROM?.trim());
}

// Une erreur axios contient la requête complète (clé API, destinataire, lien de
// réinitialisation) : on ne laisse jamais remonter que le code HTTP et le code réseau.
function safeMailError(error) {
  const status = error?.response?.status;
  return Object.assign(new Error(`Envoi d’e-mail refusé (${status || error?.code || 'erreur réseau'}).`), {
    status: 502,
    providerStatus: status || null,
    code: error?.code || null,
  });
}

// Adresse de test de Resend (sans domaine vérifié) : Resend n'envoie alors qu'au titulaire du compte.
// Les alertes administrateur fonctionnent, pas les e-mails aux joueurs (mot de passe oublié).
function sandboxSender() {
  return /@resend\.dev>?\s*$/i.test(process.env.MAIL_FROM?.trim() || '');
}
function playerMailAvailable() {
  return mailConfigured() && !sandboxSender();
}

async function sendMail({ to, subject, html, text }, http = axios) {
  if (!mailConfigured()) throw Object.assign(new Error('Envoi d’e-mails non configuré.'), { status: 503 });
  try {
    await http.post(
      'https://api.resend.com/emails',
      { from: process.env.MAIL_FROM.trim(), to: [to], subject, html, text },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}` }, timeout: 10000 },
    );
  } catch (error) {
    throw safeMailError(error);
  }
}

module.exports = { mailConfigured, playerMailAvailable, sandboxSender, sendMail, safeMailError };
