const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { load } = require('cheerio');
const ORIGIN = 'https://www.fencingtimelive.com';
function failure(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

// A new isolated session for each manual control. No cookies or credentials leave this module.
function createClient({
  email = process.env.FTL_ACCOUNT_EMAIL,
  password = process.env.FTL_ACCOUNT_PASSWORD,
  http = axios,
} = {}) {
  const jar = new CookieJar();
  const deadline = Date.now() + 75000;
  async function request(path, method = 'GET', data, headers = {}) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password)
      throw failure('Source FencingTimeLive non autorisée.', 400);
    let response;
    if (Date.now() >= deadline) throw failure('Le contrôle a dépassé le délai prévu. Réessayez plus tard.');
    try {
      response = await http.request({
        url: url.href,
        method,
        data,
        timeout: Math.min(12000, deadline - Date.now()),
        maxRedirects: 0,
        maxContentLength: 8 * 1024 * 1024,
        validateStatus: () => true,
        headers: {
          Accept: 'text/html,application/json',
          'Accept-Language': 'en-US',
          Cookie: await jar.getCookieString(url.href),
          ...headers,
        },
      });
    } catch {
      throw failure('FencingTimeLive ne répond pas. Réessayez plus tard.');
    }
    for (const cookie of response.headers['set-cookie'] || []) await jar.setCookie(cookie, url.href);
    return response;
  }
  return {
    async login() {
      if (!email || !password)
        throw failure('Le compte FencingTimeLive dédié doit être configuré sur le serveur.', 503);
      const page = await request('/account/login');
      const token = typeof page.data === 'string' && load(page.data)('meta[name="csrf_token"]').attr('content');
      if (page.status !== 200 || !token)
        throw failure('La connexion FencingTimeLive a changé. Vérification administrateur requise.');
      const result = await request('/login', 'POST', new URLSearchParams({ username: email, password }).toString(), {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-csrf-token': token,
      });
      if (result.status !== 200)
        throw failure(
          'Connexion du compte FencingTimeLive refusée. Vérifiez le mot de passe et la validation de l’e-mail.',
          503,
        );
    },
    async get(path) {
      const response = await request(path);
      if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403)
        throw failure('Session FencingTimeLive indisponible. Vérifiez le compte dédié.', 503);
      if (response.status !== 200) throw failure('La source officielle est temporairement indisponible.');
      if (typeof response.data === 'string' && /id=["']loginForm["']/.test(response.data))
        throw failure('Connexion FencingTimeLive requise.', 503);
      return response.data;
    },
    async eventPage(path) {
      const initial = new URL(path, ORIGIN),
        id = /^\/events\/view\/([a-f0-9]{32})$/i.exec(initial.pathname)?.[1];
      if (initial.origin !== ORIGIN || !id || initial.search || initial.hash)
        throw failure('Lien d’épreuve invalide.', 400);
      let url = initial;
      for (let redirects = 0; redirects < 5; redirects++) {
        const response = await request(url.href);
        if (response.status >= 300 && response.status < 400) {
          const next = new URL(response.headers.location || '/', url);
          const allowed = new RegExp(
            `^/(?:events/(?:view|competitors|format|results)/${id}|(?:pools|tableaus)/scores/${id}/[a-f0-9]{32})$`,
            'i',
          );
          if (
            next.origin !== ORIGIN ||
            next.username ||
            next.password ||
            next.search ||
            next.hash ||
            !allowed.test(next.pathname)
          )
            throw failure('Redirection officielle non vérifiable.');
          url = next;
          continue;
        }
        if (response.status !== 200 || typeof response.data !== 'string' || /id=["']loginForm["']/.test(response.data))
          throw failure('Épreuve officielle indisponible.');
        return { html: response.data, url: url.href };
      }
      throw failure('Trop de redirections pour cette épreuve.');
    },
  };
}
module.exports = { createClient, failure, ORIGIN };
