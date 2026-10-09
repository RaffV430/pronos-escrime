// État du suivi automatique FencingTimeLive, pour l'administration, et alertes aux administrateurs
// quand une épreuve n'est plus contrôlée (3 échecs d'affilée), puis quand le suivi est rétabli.
const { reportError } = require('../lib/report');

const ALERT_AFTER = 3; // échecs consécutifs
const LATE_MS = 10 * 60000; // contrôle prévu dépassé de plus de 10 min

function health(state, competition, now = Date.now()) {
  const next = state?.nextAutomaticAt ? new Date(state.nextAutomaticAt).getTime() : null;
  const late = next !== null && now - next > LATE_MS && state?.status !== 'COMPLETE';
  const level = !state
    ? 'waiting'
    : state.status === 'ERROR' || state.failures >= ALERT_AFTER
      ? 'error'
      : state.status === 'ATTENTION' || late
        ? 'warning'
        : 'ok';
  return {
    competitionId: competition.id,
    competition: competition.name,
    tournament: competition.tournament?.name || null,
    status: state?.status || 'PENDING',
    level,
    late,
    failures: state?.failures || 0,
    lastError: state?.lastError || null,
    lastFinishedAt: state?.lastFinishedAt || null,
    nextAutomaticAt: state?.nextAutomaticAt || null,
  };
}

async function syncHealth(db, now = Date.now()) {
  const competitions = await db.competition.findMany({
    where: {
      tournament: { archivedAt: null },
      OR: [{ rosterSourceUrl: { not: null } }, { ftlEventId: { not: null } }],
    },
    select: { id: true, name: true, tournament: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
  const states = await db.ftlSyncState.findMany({ where: { competitionId: { in: competitions.map((c) => c.id) } } });
  const rows = competitions.map((c) =>
    health(
      states.find((s) => s.competitionId === c.id),
      c,
      now,
    ),
  );
  return {
    workerEnabled: process.env.FTL_AUTO_SYNC === 'true',
    // Canaux d'alerte des administrateurs : sans e-mail, seules les notifications arrivent.
    mailConfigured: require('./mailer').mailConfigured(),
    mailSandbox: require('./mailer').sandboxSender(),
    pushConfigured: require('./pushNotifications').configured(),
    checkedAt: new Date(now).toISOString(),
    summary: {
      error: rows.filter((r) => r.level === 'error').length,
      warning: rows.filter((r) => r.level === 'warning').length,
      ok: rows.filter((r) => r.level === 'ok').length,
    },
    competitions: rows,
  };
}

// E-mail (si configuré) et notification à chaque administrateur ; un échec d'envoi n'interrompt rien.
async function notifyAdmins(db, { title, body, tag, url }, deps = {}) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const destination =
    String(url || '/admin').startsWith('/?') && !String(tag).startsWith('no-time-')
      ? `/admin?panel=sync&${String(url)
          .slice(2)
          .replace(/(^|&)admin=sync(&|$)/, '$1')}`
      : url;
  const link = new URL(destination || '/admin', require('./account').appUrl());
  if (link.origin !== new URL(require('./account').appUrl()).origin) throw new Error('Destination invalide.');
  let badgeCount;
  try {
    badgeCount = (await require('./adminAlerts').summary(db)).total;
  } catch {
    // Notification delivery must survive a temporary failure of the summary query.
  }
  const admins = await db.user.findMany({ where: { isAdmin: true }, select: { id: true, email: true, name: true } });
  const sent = { mail: 0, push: 0, mailFailed: 0, pushFailed: 0, mailConfigured: false, pushConfigured: false };
  const mailer = deps.mailer || require('./mailer');
  sent.mailConfigured = mailer.mailConfigured();
  if (sent.mailConfigured)
    for (const admin of admins) {
      try {
        await mailer.sendMail({
          to: admin.email,
          subject: title,
          text: `${body}\n\nOuvrir le panneau d’administration : ${link.href}\nSi votre session a expiré, connectez-vous pour retrouver ce panneau.`,
          html: `<p>${escape(body)}</p><p><a href="${escape(link.href)}">Ouvrir le panneau d’administration</a></p><p>Si votre session a expiré, connectez-vous pour retrouver ce panneau.</p>`,
        });
        sent.mail++;
      } catch (e) {
        sent.mailFailed++;
        reportError(e, 'alerte administrateur (e-mail)');
      }
    }
  const push = deps.push || require('./pushNotifications');
  sent.pushConfigured = push.configured();
  if (sent.pushConfigured) {
    const subs = await db.pushSubscription.findMany({
      where: { enabled: true, userId: { in: admins.map((a) => a.id) } },
    });
    for (const sub of subs) {
      try {
        await push.send(
          sub,
          {
            title,
            body,
            tag,
            url: link.pathname + link.search,
            adminAlert: true,
            ...(Number.isInteger(badgeCount) ? { badgeCount } : {}),
          },
          3600,
          'high',
        );
        sent.push++;
      } catch (e) {
        sent.pushFailed++;
        reportError(e, 'alerte administrateur (notification)');
      }
    }
  }
  return sent;
}

// Résultat d'une alerte dans le journal d'administration (envois réussis ou échoués, canaux actifs).
async function logResult(db, entry, result) {
  try {
    if (entry?.id) await db.auditLog.update({ where: { id: entry.id }, data: { after: result } });
  } catch {
    /* journal facultatif */
  }
  return result;
}

// Demi-finale, petite finale ou finale close par la règle par défaut (10 min après le tour précédent)
// faute d'horaire FencingTimeLive : alerte des administrateurs, une fois par match.
const NO_TIME_ACTION = 'Alerte clôture sans horaire';
const NO_TIME_ROUNDS = { T4: 'Demi-finale', Bronze: 'Petite finale', T2: 'Finale' };
function closedWithoutTime(timed, now = Date.now()) {
  const { matchClosed } = require('../lib/matchLock');
  return timed.filter(
    (m) =>
      NO_TIME_ROUNDS[m.round] &&
      !m.startsAt &&
      !m.isFinished &&
      !m.isLocked &&
      !m.syncIssue &&
      !m.manualUnlockUntil &&
      m.resultType !== 'CANCELLED' &&
      m.previousRoundCompletedAt &&
      m.player1?.trim() &&
      m.player2?.trim() &&
      matchClosed(m, now),
  );
}
async function alertClosedWithoutTime(db, competition, deps = {}) {
  try {
    const raw = await db.match.findMany({ where: { competitionId: competition.id } });
    const found = closedWithoutTime(await require('./roundTiming').timedMatches(db, raw), deps.now);
    if (!found.length) return [];
    const done = await db.auditLog.findMany({
      where: { action: NO_TIME_ACTION, targetType: 'Match', targetId: { in: found.map((m) => m.id) } },
      select: { targetId: true },
    });
    const alerted = [];
    for (const m of found.filter((x) => !done.some((d) => d.targetId === x.id))) {
      // Journal d'abord : jamais deux alertes pour le même match, même si l'envoi échoue.
      const entry = await db.auditLog.create({
        data: { actorId: 0, action: NO_TIME_ACTION, targetType: 'Match', targetId: m.id },
      });
      const label = NO_TIME_ROUNDS[m.round];
      const at = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(new Date(m.previousRoundCompletedAt).getTime() + 10 * 60000));
      await notifyAdmins(
        db,
        {
          title: `${label} close sans horaire · ${competition.name}`,
          body: `${m.player1} / ${m.player2} : pronostics clos à ${at} (10 minutes après le tour précédent), FencingTimeLive n'a pas publié d'heure. La saisie rouvrira d'elle-même si l'heure est publiée ; sinon, réouverture manuelle possible dans l'administration du tableau.`,
          tag: `no-time-${m.id}`,
          url: `/?tournament=${competition.tournamentId}&event=${competition.id}&matches=${m.id}`,
        },
        deps,
      ).then((result) => logResult(db, entry, result));
      alerted.push(m.id);
    }
    return alerted;
  } catch (e) {
    reportError(e, 'alerte clôture sans horaire');
    return [];
  }
}

// Import bloqué sans panne (poule ou tableau refusés, avertissements) pendant l'épreuve : alerte des
// administrateurs dès le 2e contrôle d'affilée avec les mêmes avertissements, une fois par série ;
// puis « rétabli » quand plus rien n'est signalé.
const ATTENTION_ACTION = 'Alerte suivi à vérifier';
const RECOVERED_ACTION = 'Alerte suivi à vérifier rétabli';
const signatureOf = (warnings) => [...new Set(warnings || [])].sort().join(' | ').slice(0, 1500);
async function alertAttention(db, { competitionId, previousStatus, warnings, duringEvent }, deps = {}) {
  try {
    const last = await db.auditLog.findFirst({
      where: {
        targetType: 'Competition',
        targetId: competitionId,
        action: { in: [ATTENTION_ACTION, RECOVERED_ACTION] },
      },
      orderBy: { id: 'desc' },
    });
    const open = last?.action === ATTENTION_ACTION;
    const competition = await db.competition.findUnique({
      where: { id: competitionId },
      select: { name: true, tournamentId: true },
    });
    const name = competition?.name || `épreuve ${competitionId}`;
    if (!warnings?.length) {
      if (!open) return null;
      const entry = await db.auditLog.create({
        data: { actorId: 0, action: RECOVERED_ACTION, targetType: 'Competition', targetId: competitionId },
      });
      const sent = await notifyAdmins(
        db,
        {
          title: `Suivi rétabli · ${name}`,
          body: 'Plus aucun avertissement : l’import reprend normalement.',
          tag: `attention-${competitionId}`,
          url: '/?admin=sync',
        },
        deps,
      );
      await logResult(db, entry, sent);
      return { kind: 'recovered', ...sent };
    }
    const signature = signatureOf(warnings);
    if (!duringEvent || previousStatus !== 'ATTENTION' || (open && last.after?.signature === signature)) return null;
    const entry = await db.auditLog.create({
      data: {
        actorId: 0,
        action: ATTENTION_ACTION,
        targetType: 'Competition',
        targetId: competitionId,
        after: { signature },
      },
    });
    const list = [...new Set(warnings)].slice(0, 4).join(' · ');
    const sent = await notifyAdmins(
      db,
      {
        title: `Import à vérifier · ${name}`,
        body: `Deux contrôles d'affilée signalent : ${list}. Voir Administration → Suivi.`,
        tag: `attention-${competitionId}`,
        url: competition ? `/?tournament=${competition.tournamentId}&event=${competitionId}` : '/?admin=sync',
      },
      deps,
    );
    await logResult(db, entry, { signature, ...sent });
    return { kind: 'attention', ...sent };
  } catch (e) {
    reportError(e, 'alerte import à vérifier');
    return null;
  }
}

// Appelé après chaque contrôle. N'alerte qu'au passage du seuil (pas à chaque échec) et au rétablissement.
async function alertAdmins(db, { competitionId, failures, previousFailures, error }, deps = {}) {
  const crossed = failures === ALERT_AFTER;
  const recovered = failures === 0 && previousFailures >= ALERT_AFTER;
  if (!crossed && !recovered) return null;
  try {
    const competition = await db.competition.findUnique({ where: { id: competitionId }, select: { name: true } });
    const name = competition?.name || `épreuve ${competitionId}`;
    const title = crossed ? `Suivi FencingTimeLive en panne · ${name}` : `Suivi FencingTimeLive rétabli · ${name}`;
    const body = crossed
      ? `${ALERT_AFTER} contrôles d'affilée ont échoué (${error || 'erreur inconnue'}). Les pronostics de poules se bloquent tant que la lecture échoue. Voir Administration → Suivi.`
      : 'Les contrôles automatiques fonctionnent de nouveau.';
    const sent = await notifyAdmins(db, { title, body, tag: `ftl-${competitionId}`, url: '/?admin=sync' }, deps);
    await db.auditLog
      ?.create({
        data: {
          actorId: 0,
          action: crossed ? 'Alerte suivi FTL en panne' : 'Alerte suivi FTL rétabli',
          targetType: 'Competition',
          targetId: competitionId,
          after: sent,
        },
      })
      ?.catch(() => {});
    if (crossed)
      reportError(new Error(`${title} : ${error || 'erreur inconnue'}`), 'suivi FencingTimeLive', { competitionId });
    return { kind: crossed ? 'down' : 'recovered', ...sent };
  } catch (e) {
    reportError(e, 'alerte administrateur');
    return null;
  }
}

// Site officiel figé : en pleine épreuve, plus aucun nouveau résultat (poule ou tableau) depuis longtemps,
// sans phase annoncée plus tard. Seuils larges : poules longues (jusqu'à 2 h) et premiers tours de tableau
// lents à remonter (1 h et plus). Alerte des administrateurs, une fois par période de silence.
const STALE_ACTION = 'Site officiel figé';
const STALE_POOLS = 150 * 60000; // 2 h 30 sans résultat pendant les poules
const STALE_TABLEAU = 105 * 60000; // 1 h 45 pendant le tableau
async function alertStale(db, { competitionId, eventStart, complete, timezone = 'Europe/Paris' }, deps = {}) {
  try {
    const now = deps.now || new Date();
    if (complete || !eventStart) return null;
    const start = new Date(eventStart).getTime();
    if (!(now.getTime() > start + 30 * 60000)) return null;
    // Nuit (épreuve sur plusieurs jours) : pas d'alerte entre 22 h et 7 h, heure du lieu.
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now),
    );
    if (hour >= 22 || hour < 7) return null;
    const [lastMatch, lastPool, nextMatch, nextPool, tableauStarted] = await Promise.all([
      db.match.aggregate({ where: { competitionId }, _max: { resultRegisteredAt: true } }),
      db.poolFencer.aggregate({ where: { pool: { competitionId } }, _max: { firstResultAt: true } }),
      db.match.findFirst({
        where: { competitionId, startsAt: { gt: now }, isFinished: false },
        select: { startsAt: true },
        orderBy: { startsAt: 'asc' },
      }),
      db.pool.findFirst({
        where: { competitionId, startsAt: { gt: now }, isFinal: false },
        select: { startsAt: true },
        orderBy: { startsAt: 'asc' },
      }),
      db.match.count({ where: { competitionId, startsAt: { lte: now } } }),
    ]);
    // Une phase annoncée plus tard dans la journée : l'attente est normale.
    for (const next of [nextMatch, nextPool])
      if (next && new Date(next.startsAt).getTime() - now.getTime() < 18 * 3600000) return null;
    const last = Math.max(
      start,
      ...[lastMatch._max.resultRegisteredAt, lastPool._max.firstResultAt]
        .filter(Boolean)
        .map((d) => new Date(d).getTime()),
    );
    const limit = tableauStarted ? STALE_TABLEAU : STALE_POOLS;
    if (now.getTime() - last < limit) return null;
    const since = new Date(last).toISOString();
    const previous = await db.auditLog.findFirst({
      where: { action: STALE_ACTION, targetType: 'Competition', targetId: competitionId },
      orderBy: { id: 'desc' },
    });
    if (previous?.after?.since === since) return null;
    const competition = await db.competition.findUnique({
      where: { id: competitionId },
      select: { name: true, tournamentId: true },
    });
    const minutes = Math.round((now.getTime() - last) / 60000);
    const duration = `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
    const entry = await db.auditLog.create({
      data: { actorId: 0, action: STALE_ACTION, targetType: 'Competition', targetId: competitionId, after: { since } },
    });
    const sent = await notifyAdmins(
      db,
      {
        title: `Site officiel figé ? · ${competition?.name || `épreuve ${competitionId}`}`,
        body: `Aucun nouveau résultat depuis ${duration}. Le site officiel n'est peut-être plus mis à jour : vérifiez auprès du directoire technique.`,
        tag: `stale-${competitionId}`,
        url: competition ? `/?tournament=${competition.tournamentId}&event=${competitionId}` : '/?admin=sync',
      },
      deps,
    );
    await logResult(db, entry, { since, ...sent });
    return { kind: 'stale', since, ...sent };
  } catch (e) {
    reportError(e, 'alerte site figé');
    return null;
  }
}

module.exports = {
  alertStale,
  STALE_ACTION,
  health,
  syncHealth,
  alertAdmins,
  notifyAdmins,
  closedWithoutTime,
  alertClosedWithoutTime,
  ALERT_AFTER,
  NO_TIME_ACTION,
  alertAttention,
  ATTENTION_ACTION,
};
