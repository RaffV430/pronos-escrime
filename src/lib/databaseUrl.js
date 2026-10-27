// Neon endormie met parfois plus de 5 s (délai de connexion par défaut de Prisma) à accepter la connexion :
// on lui laisse 30 s, sauf si l'adresse de la base fixe déjà son propre délai.
function databaseUrl(url = process.env.DATABASE_URL) {
  if (!url || /[?&]connect_timeout=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connect_timeout=30`;
}

module.exports = { databaseUrl };
