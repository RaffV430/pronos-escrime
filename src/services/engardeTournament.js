// Aperçu d'un tournoi engarde-service (lecture seule) : épreuves, lieu, fuseau, engagés, pages officielles.
// L'import des rencontres et le suivi automatique réutiliseront ensuite le moteur de FencingTimeLive.
const axios = require('axios');
const E = require('./engardeParser');
const CONFIG = 'Configuration FTL validée'; // même journal que FencingTimeLive : une seule configuration par épreuve
const PREVIEW = 'Aperçu tournoi engarde-service';
// Identifiant d'épreuve côté app (colonne unique ftlEventId) : préfixé pour ne jamais croiser un ID FTL.
const engardeKey = (eventId) => `ENGARDE:${eventId}`;

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
        headers: {
          Accept: 'text/html,application/xml',
          'Accept-Language': 'fr-FR',
          'User-Agent': 'PronosEscrime/1.0 (+https://www.pronos-escrime.fr)',
          ...headers,
        },
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
  client ||= createEngardeClient();
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
    const eventId = `${e.org}/${e.tournamentSlug}/${e.compe}`;
    const existing = await db.competition.findUnique({ where: { ftlEventId: engardeKey(eventId) } }).catch(() => null);
    events.push({
      ...e,
      eventId,
      existingCompetitionId: existing?.id || null,
      entries,
      published: { pools: pages.pools.length > 0, tableau: pages.tableaus.length > 0, final: Boolean(pages.final) },
    });
  }
  const timezone = String(input.timezone || '') || events.find((e) => e.timezone)?.timezone || null;
  let title = null;
  try {
    title = E.parseTournamentTitle(await client.get(`${E.ORIGIN}/tournament/${link.org}/${link.event}`));
  } catch {
    title = null;
  }
  // Heure de début en UTC (l'admin la voit aussi à l'heure de Paris pour vérifier le fuseau).
  const { eventStart } = require('./eventStart');
  for (const e of events) {
    const start = timezone ? eventStart({ date: e.date, time: e.time, timezone }) : null;
    e.startsAt = start ? new Date(start).toISOString() : null;
  }
  const result = {
    provider: 'engarde',
    sourceUrl: `${E.ORIGIN}/tournament/${link.org}/${link.event}`,
    tournament: title || link.event,
    city: events[0].city,
    timezone,
    events,
  };
  const saved = await db.auditLog.create({
    data: {
      actorId,
      action: PREVIEW,
      targetType: 'EngardePreview',
      targetId: actorId,
      after: result,
    },
  });
  return { ...result, previewId: saved.id };
}

// Enregistre le tournoi et les épreuves choisies, même vides : le suivi automatique reviendra jusqu'à la
// publication des engagés, des poules puis du tableau.
async function save(db, input, actorId, client = createEngardeClient()) {
  client ||= createEngardeClient();
  const previewId = Number(input.previewId),
    ids = input.eventIds;
  if (
    !Number.isSafeInteger(previewId) ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 32 ||
    ids.some((i) => typeof i !== 'string') ||
    new Set(ids).size !== ids.length
  )
    throw new E.EngardeError('Sélectionnez au moins une épreuve.', 400);
  const entry = await db.auditLog.findUnique({ where: { id: previewId } });
  if (
    !entry ||
    entry.actorId !== actorId ||
    entry.targetType !== 'EngardePreview' ||
    Date.now() - entry.createdAt.getTime() > 900000
  )
    throw new E.EngardeError('Aperçu expiré. Relisez le tournoi.', 409);
  const preview = entry.after;
  const timezone = preview.timezone;
  if (!timezone) throw new E.EngardeError('Choisissez la ville du lieu de compétition.', 400);
  const selected = preview.events.filter((e) => ids.includes(e.eventId));
  if (selected.length !== ids.length) throw new E.EngardeError('Sélection extérieure à cet aperçu.', 400);
  const link = E.parseLink(preview.sourceUrl);
  const fresh = E.parseCompetitions(await client.competitions(link.org, link.event), {
    org: link.org,
    event: link.event,
  });
  const observations = [];
  for (const e of selected) {
    const latest = fresh.find((x) => x.compe === e.compe);
    if (!latest || ['date', 'time', 'format', 'event'].some((k) => latest[k] !== e[k]))
      throw new E.EngardeError('La liste des épreuves a changé. Relisez le tournoi.', 409);
    const pages = E.competitionPages(await client.get(latest.eventSourceUrl), { ...link, compe: latest.compe });
    let roster = null;
    if (pages.roster)
      try {
        roster = E.parseRoster(await client.get(pages.roster));
      } catch {
        roster = null;
      }
    observations.push({ event: { ...latest, eventId: e.eventId }, pages, roster });
  }
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184722)`;
      const keys = observations.map((o) => engardeKey(o.event.eventId));
      const existing = await tx.competition.findMany({ where: { ftlEventId: { in: keys } } });
      const linked = await tx.tournament.findUnique({ where: { ftlSourceUrl: preview.sourceUrl } });
      const targetIds = [...new Set([...existing.map((c) => c.tournamentId), ...(linked ? [linked.id] : [])])];
      if (targetIds.length > 1)
        throw new E.EngardeError(
          'Ces épreuves sont déjà réparties entre plusieurs tournois. Vérification requise.',
          409,
        );
      const tournament = targetIds.length
        ? await tx.tournament.update({ where: { id: targetIds[0] }, data: { ftlSourceUrl: preview.sourceUrl } })
        : await tx.tournament.create({ data: { name: preview.tournament, ftlSourceUrl: preview.sourceUrl } });
      const results = [];
      for (const { event, pages, roster } of observations) {
        const key = engardeKey(event.eventId);
        let c = existing.find((x) => x.ftlEventId === key),
          created = !c;
        if (c && c.podiumFormat !== event.format) throw new E.EngardeError('Format existant différent.', 409);
        if (!c)
          c = await tx.competition.create({
            data: { name: event.event, tournamentId: tournament.id, podiumFormat: event.format, ftlEventId: key },
          });
        if (roster && !c.podiumRoster)
          c = await tx.competition.update({
            where: { id: c.id },
            data: { podiumRoster: roster, rosterSourceUrl: pages.roster, rosterCheckedAt: new Date() },
          });
        const config = {
          provider: 'engarde',
          org: event.org,
          tournamentSlug: event.tournamentSlug,
          compe: event.compe,
          eventId: event.eventId,
          eventSourceUrl: event.eventSourceUrl,
          tournament: preview.tournament,
          event: event.event,
          date: event.date,
          time: event.time,
          timezone,
          city: event.city,
          country: event.country,
          format: event.format,
          name: c.name,
        };
        await tx.auditLog.create({
          data: { actorId, action: CONFIG, targetType: 'Competition', targetId: c.id, after: config },
        });
        results.push({
          competitionId: c.id,
          name: c.name,
          created,
          pending: !c.podiumRoster,
          entries: c.podiumRoster?.length || 0,
        });
      }
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'Tournoi engarde-service configuré',
          targetType: 'Tournament',
          targetId: tournament.id,
          after: { sourceUrl: preview.sourceUrl, events: results },
        },
      });
      return { tournamentId: tournament.id, name: tournament.name, events: results };
    },
    { timeout: 30000 },
  );
}

module.exports = { createEngardeClient, preview, save, engardeKey };
