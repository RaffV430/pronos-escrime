// Envoi d'e-mails transactionnels via l'API HTTP de Resend.
// Actif uniquement si RESEND_API_KEY et MAIL_FROM sont définis.
const axios = require('axios');

function mailConfigured() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.MAIL_FROM?.trim());
}

async function sendMail({ to, subject, html, text }, http = axios) {
  if (!mailConfigured()) throw Object.assign(new Error('Envoi d’e-mails non configuré.'), { status: 503 });
  await http.post(
    'https://api.resend.com/emails',
    { from: process.env.MAIL_FROM.trim(), to: [to], subject, html, text },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}` }, timeout: 10000 },
  );
}

module.exports = { mailConfigured, sendMail };
