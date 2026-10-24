const { namesFor, concerned, isMine, hasAny } = require('./fencerNotifications');
const { roundLabel, fencerList } = require('./notificationText');

function upcomingMatch(m, now = Date.now()) {
  return Boolean(
    !m.isFinished &&
    !m.liveDetectedAt &&
    !m.syncIssue &&
    (!m.resultType || m.resultType === 'NORMAL') &&
    [m.player1, m.player2].every(
      (n) => typeof n === 'string' && n.trim() && !/^(exempt|bye|vainqueur)\b/i.test(n.trim()),
    ) &&
    (!m.startsAt || new Date(m.startsAt).getTime() > now),
  );
}
function upcomingPool(p, now = Date.now()) {
  return (
    !p.isFinal &&
    !p.isLocked &&
    p.lockMode !== 'PROVISIONAL' &&
    !p.fencers.some((f) => f.firstResultAt) &&
    (!p.startsAt || new Date(p.startsAt).getTime() > now)
  );
}
function scheduleText(c, row, names, timezone, pool = false) {
  const start = row.startsAt ? new Date(row.startsAt) : null;
  const when =
    start && Number.isFinite(start.getTime())
      ? new Intl.DateTimeFormat('fr-FR', {
          timeZone: timezone,
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(start)
      : 'heure à confirmer';
  const strip = row.strip ? `Piste ${row.strip.replace(/^piste\s+/i, '')}` : 'piste à confirmer';
  const who = pool
    ? `${fencerList(row.fencers.filter((f) => isMine(names, f.name, f.club)).map((f) => f.name))} · ${row.name}`
    : `${row.player1} – ${row.player2} · ${roundLabel(row.round)}`;
  return { title: c.name, body: `${who} · ${strip} · ${when}` };
}
async function queueSchedules(tx, sub, context, now = Date.now()) {
  for (const x of context) {
    const c = x.competition;
    const start = await require('./eventStart').eventStartFor(tx, c.id);
    if (c.podiumResolvedAt || (start && now - start >= 3 * 86400000)) continue;
    const names = await namesFor(tx, sub, c);
    if (!hasAny(names)) continue;
    const add = async (kind, row) => {
      const key = {
        subscriptionId: sub.id,
        competitionId: c.id,
        throughEventId: 0,
        kind,
        round: `${kind === 'FENCER_MATCH_SCHEDULE' ? 'match' : 'pool'}-${row.id}`,
      };
      await tx.pushDelivery.upsert({
        where: { subscriptionId_competitionId_throughEventId_kind_round: key },
        create: { ...key, matchIds: [row.id] },
        update: {},
      });
    };
    for (const m of x.matches) if (upcomingMatch(m, now) && concerned(m, names)) await add('FENCER_MATCH_SCHEDULE', m);
    for (const p of x.pools || [])
      if (upcomingPool(p, now) && p.fencers.some((f) => isMine(names, f.name, f.club)))
        await add('FENCER_POOL_SCHEDULE', p);
  }
}
module.exports = { upcomingMatch, upcomingPool, scheduleText, queueSchedules };
