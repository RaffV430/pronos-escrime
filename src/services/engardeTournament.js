// Aperçu d'un tournoi engarde-service (lecture seule) : épreuves, lieu, fuseau, engagés, pages officielles.
// L'import des rencontres et le suivi automatique réutiliseront ensuite le moteur de FencingTimeLive.
const axios = require('axios');
const E = require('./engardeParser');

function createEngardeClient({ http = axios } = {}) {
  const deadline = Date.now() + 60000;
  async function request(path, { method = 'GET', data, headers = {} } = {}) {
    const url = new URL(path, E.ORIGIN);
    if (url.origin !== E.ORIGIN || url.username || url.password)
      throw new E.EngardeError('Source engarde-service non autorisée.', 400);
    if (Date.now() >= deadline) throw new E.EngardeError('La lecture a dépassé le délai prévu. Réessayez plus tard.');
    let response;
    try {
      response = await http.request({
        url: url.href,
        method,
        data,
        timeout: Math.min(12000, deadline - Date.now()),
        maxRedirects: 2,
        maxContentLength: 4 * 1024 * 1024,
        responseType: 'text',
        validateStatus: () => true,
        headers: { Accept: 'text/html,application/xml', 'Accept-Language': 'fr-FR', ...headers },
      });
    } catch {
      throw new E.EngardeError('engarde-service ne répond pas. Réessayez plus tard.');
    }
    if (response.status !== 200) throw new E.EngardeError(`engarde-service indisponible (${response.status}).`);
    return String(response.data || '');
  }
  return {
    get: (path) => request(path),
    competitions: (org, event) =>
      request('/prog/getCompeForDisplay.php', {
        method: 'POST',
        data: E.competitionsRequest(org, event),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
  };
}

async function preview(db, input, actorId, client = createEngardeClient()) {
  const link = E.parseLink(input.sourceUrl);
  if (!link) throw new E.EngardeError('Lien engarde-service non reconnu.', 400);
  const all = E.parseCompetitions(await client.competitions(link.org, link.event), {
    org: link.org,
    event: link.event,
  });
  // Lien d'une épreuve : seule cette épreuve est proposée.
  const selected = link.kind === 'competition' ? all.filter((e) => e.compe === link.compe) : all;
  if (!selected.length) throw new E.EngardeError('Épreuve absente de la liste officielle du tournoi.', 404);
  const events = [];
  for (const e of selected) {
    const pages = E.competitionPages(await client.get(e.eventSourceUrl), { ...link, compe: e.compe });
    let entries = 0;
    if (pages.roster)
      try {
        entries = E.parseRoster(await client.get(pages.roster)).length;
      } catch {
        entries = 0; // liste pas encore publiée
      }
    events.push({
      ...e,
      eventId: `${e.org}/${e.tournamentSlug}/${e.compe}`,
      entries,
      published: { pools: pages.pools.length > 0, tableau: pages.tableaus.length > 0, final: Boolean(pages.final) },
    });
  }
  const timezone = String(input.timezone || '') || events.find((e) => e.timezone)?.timezone || null;
  const result = {
    provider: 'engarde',
    sourceUrl: `${E.ORIGIN}/tournament/${link.org}/${link.event}`,
    tournament: events[0].title.replace(/\s+\S+$/, '') || link.event,
    city: events[0].city,
    timezone,
    events,
    importAvailable: false,
  };
  const saved = await db.auditLog.create({
    data: {
      actorId,
      action: 'Aperçu tournoi engarde-service',
      targetType: 'EngardePreview',
      targetId: actorId,
      after: result,
    },
  });
  return { ...result, previewId: saved.id };
}

module.exports = { createEngardeClient, preview };
