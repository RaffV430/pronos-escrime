const { load } = require('cheerio');
const { createClient, failure, ORIGIN } = require('./ftlClient');
const { clean, norm } = require('./ftlParser');
const { cleanCity, utcOffset, offsetLabel } = require('./venue');
const SOURCE = /^https:\/\/www\.fencingtimelive\.com\/(tableaus|pools)\/scores\/([a-f0-9]{32})\/[a-f0-9]{32}$/i;
const CONFIG = 'Configuration FTL validée';
async function configuration(db, competitionId) {
  const row = await db.auditLog.findFirst({
    where: { action: CONFIG, targetType: 'Competition', targetId: competitionId },
    orderBy: { id: 'desc' },
  });
  if (!row?.after) return null;
  // Lieu, date ou jour d'une phase corrigés par un administrateur après cette configuration.
  const schedule = require('./schedule');
  return schedule.merge(row.after, await schedule.correctionOf(db, competitionId, row.id));
}
function parseRoster(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2048)
    throw failure('Liste des engagés non publiée ou trop volumineuse.');
  const entries = rows.map((r) => {
    // Motif précis (nom compris) : l'administrateur voit tout de suite quelle ligne bloque la liste.
    const who = clean(r?.name) || 'engagé sans nom';
    if (typeof r.id !== 'string' || !/^[a-f0-9]{16,64}$/i.test(r.id))
      throw failure(`Identité d’un engagé non vérifiable : ${who} (identifiant officiel absent).`);
    if (!clean(r.name)) throw failure('Identité d’un engagé non vérifiable : nom absent.');
    // Club ou nation non renseigné sur la source : accepté (vide), l'identifiant officiel suffit.
    if (r.country !== null && r.country !== undefined && typeof r.country !== 'string')
      throw failure(`Identité d’un engagé non vérifiable : ${who} (club ou nation illisible).`);
    const rank = r.rank === null || r.rank === undefined || r.rank === '' ? null : Number(r.rank);
    if (rank !== null && (!Number.isSafeInteger(rank) || rank <= 0)) throw failure('Rang d’engagement non vérifiable.');
    return {
      id: r.id,
      name: clean(r.name),
      country: clean(r.country || ''),
      active: r.status !== 'Scratched',
      entryRanking: rank,
    };
  });
  if (new Set(entries.map((r) => r.id)).size !== entries.length) throw failure('Identifiants d’engagés dupliqués.');
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
async function preview(db, input, actorId, client = createClient()) {
  if (require('./engardeParser').parseLink(input.sourceUrl))
    throw failure(
      'Pour engarde-service, utilisez « Préparer un tournoi » avec le lien du tournoi ou d’une épreuve.',
      400,
    );
  const sourceUrl = String(input.sourceUrl || '').trim(),
    match = SOURCE.exec(sourceUrl);
  if (!match)
    throw failure(
      'Indiquez un lien officiel de poules ou de tableau FencingTimeLive, ou une page d’épreuve engarde-service.',
      400,
    );
  const timezone = String(input.timezone || '');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw failure('Fuseau horaire IANA invalide (exemple : Europe/Istanbul).', 400);
  }
  if (!timezone) throw failure('Fuseau horaire requis.', 400);
  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)))
    throw failure('Date locale de l’épreuve requise.', 400);
  const format = input.format;
  if (!['TEAM', 'INDIVIDUAL'].includes(format)) throw failure('Format individuel ou équipes requis.', 400);
  await client.login();
  const $ = load(await client.get(sourceUrl));
  const tournament = clean($('.desktop.tournName').text()),
    event = clean($('.desktop.eventName').text()),
    eventTime = clean($('.desktop.eventTime').text());
  if (!tournament || !event || !eventTime) throw failure('Identité officielle de l’épreuve indisponible.');
  if (/\bteam\b/i.test(event) !== (format === 'TEAM'))
    throw failure('Le format ne correspond pas à l’épreuve officielle.', 400);
  const displayedDate = Date.parse(eventTime + ' UTC');
  if (!Number.isFinite(displayedDate) || new Date(displayedDate).toISOString().slice(0, 10) !== date)
    throw failure('La date saisie ne correspond pas à la date officielle.', 400);
  const eventId = match[2].toUpperCase(),
    rosterSourceUrl = `${ORIGIN}/events/competitors/${eventId}`;
  const links = $('a')
    .toArray()
    .map((a) => new URL($(a).attr('href') || '/', ORIGIN).href);
  if (!links.includes(rosterSourceUrl)) throw failure('Lien des engagés absent de la page officielle.');
  const rosterPage = load(await client.get(rosterSourceUrl));
  if (
    norm(rosterPage('.desktop.eventName').text()) !== norm(event) ||
    norm(rosterPage('.desktop.tournName').text()) !== norm(tournament) ||
    norm(rosterPage('.desktop.eventTime').text()) !== norm(eventTime)
  )
    throw failure('La liste des engagés concerne une autre épreuve.');
  const dataUrl = rosterPage('#compList').attr('data-url');
  if (dataUrl !== `/events/competitors/data/${eventId}`) throw failure('Liste officielle des engagés non reconnue.');
  const roster = parseRoster(await client.get(dataUrl));
  const related = links.filter((url) => SOURCE.test(url) && SOURCE.exec(url)[2].toUpperCase() === eventId);
  const tableau = [...new Set(related.filter((u) => u.includes('/tableaus/')))];
  if (tableau.length > 1) throw failure('Plusieurs tableaux : sélectionner la source principale avant configuration.');
  const city = cleanCity(input.city);
  const config = {
    tournament,
    event,
    eventTime,
    date,
    timezone,
    ...(city ? { city } : {}),
    format,
    sourceUrl: tableau[0] || null,
    poolSources: [...new Set(related.filter((u) => u.includes('/pools/')))],
    rosterSourceUrl,
    eventId,
  };
  const saved = await db.auditLog.create({
    data: {
      actorId,
      action: 'Aperçu configuration FTL',
      targetType: 'FtlSetupPreview',
      targetId: actorId,
      after: { config, roster },
    },
  });
  const start = require('./eventStart').eventStart(config);
  return {
    previewId: saved.id,
    ...config,
    offset: offsetLabel(utcOffset(timezone, start || Date.now())),
    startsAt: start ? new Date(start).toISOString() : null,
    entries: roster,
  };
}
async function save(db, input, actorId) {
  const previewId = Number(input.previewId),
    competitionId = input.competitionId ? Number(input.competitionId) : null,
    tournamentId = input.tournamentId ? Number(input.tournamentId) : null;
  if (
    !Number.isSafeInteger(previewId) ||
    previewId < 1 ||
    (competitionId && !Number.isSafeInteger(competitionId)) ||
    (tournamentId && !Number.isSafeInteger(tournamentId))
  )
    throw failure('Sélection invalide.', 400);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(184722)`;
      const previous = await tx.auditLog.findFirst({
        where: { action: 'Configuration FTL enregistrée', targetType: 'FtlSetupPreview', targetId: previewId, actorId },
      });
      if (previous) return previous.after;
      const entry = await tx.auditLog.findUnique({ where: { id: previewId } });
      if (
        !entry ||
        entry.actorId !== actorId ||
        entry.targetType !== 'FtlSetupPreview' ||
        Date.now() - entry.createdAt.getTime() > 900000
      )
        throw failure('Aperçu expiré. Vérifiez à nouveau la source.', 409);
      const { config, roster } = entry.after;
      let c = competitionId ? await tx.competition.findUnique({ where: { id: competitionId } }) : null;
      if (competitionId && !c) throw failure('Épreuve introuvable.', 404);
      const duplicate = await tx.competition.findFirst({
        where: {
          OR: [{ rosterSourceUrl: config.rosterSourceUrl }, { ftlEventId: config.eventId }],
          ...(c ? { id: { not: c.id } } : {}),
        },
      });
      if (duplicate) throw failure('Cette épreuve est déjà reliée à une compétition.', 409);
      if (c) {
        await tx.$queryRaw`SELECT id FROM "Competition" WHERE id=${c.id} FOR UPDATE`;
        c = await tx.competition.findUnique({ where: { id: c.id } });
        if (
          (c.ftlEventId && c.ftlEventId !== config.eventId) ||
          (c.rosterSourceUrl && c.rosterSourceUrl !== config.rosterSourceUrl)
        )
          throw failure('La source de cette épreuve ne peut pas être remplacée.', 409);
        const sources = await tx.match.findMany({
          where: { competitionId: c.id, sourceUrl: { not: null } },
          select: { sourceUrl: true },
        });
        if (sources.some((m) => SOURCE.exec(m.sourceUrl)?.[2]?.toUpperCase() !== config.eventId))
          throw failure('Des rencontres existantes appartiennent à une autre source officielle.', 409);
        const identity = (entries) =>
          JSON.stringify((entries || []).map((e) => [e.id, norm(e.name)]).sort((a, b) => a[0].localeCompare(b[0])));
        if (c.podiumRoster && identity(c.podiumRoster) !== identity(roster))
          throw failure('La composition existante diffère : vérification manuelle requise.', 409);
        if (c.podiumRoster && c.podiumFormat !== config.format)
          throw failure('Le format existant ne peut pas être remplacé.', 409);
      } else {
        let t = tournamentId ? await tx.tournament.findUnique({ where: { id: tournamentId } }) : null;
        if (tournamentId && !t) throw failure('Tournoi introuvable.', 404);
        if (!t) t = await tx.tournament.create({ data: { name: config.tournament } });
        const name = clean(input.name) || config.event;
        if (name.length > 200) throw failure('Nom d’épreuve trop long.', 400);
        c = await tx.competition.create({ data: { name, tournamentId: t.id, podiumFormat: config.format } });
      }
      await tx.competition.update({
        where: { id: c.id },
        data: {
          ftlEventId: config.eventId,
          podiumFormat: config.format,
          ...(!c.podiumRoster
            ? { podiumRoster: roster, rosterSourceUrl: config.rosterSourceUrl, rosterCheckedAt: entry.createdAt }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: CONFIG,
          targetType: 'Competition',
          targetId: c.id,
          after: { ...config, name: c.name },
        },
      });
      const result = { competitionId: c.id, tournamentId: c.tournamentId, name: c.name };
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'Configuration FTL enregistrée',
          targetType: 'FtlSetupPreview',
          targetId: previewId,
          after: result,
        },
      });
      return result;
    },
    { timeout: 15000 },
  );
}
module.exports = { configuration, preview, save, parseRoster, SOURCE };
