const { randomUUID } = require('node:crypto');
const push = require('./pushNotifications');
const { isQuiet } = require('./playerExperience');
const PREFIX = 'announcement:';
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
function content(input) {
  if (![input?.title, input?.body, input?.url].every((v) => typeof v === 'string'))
    throw bad('Titre, message et lien requis.');
  const title = String(input?.title || '').trim(),
    body = String(input?.body || '').trim();
  const url = String(input?.url || '').trim();
  if (!title || title.length > 80 || !body || body.length > 240)
    throw bad('Titre (80 caractères) et message (240 caractères) requis.');
  if (!url.startsWith('/') || url.startsWith('//') || /[\\\s\u0000-\u001f]/.test(url) || url.length > 500)
    throw bad('Choisissez un lien interne à Pronos Escrime.');
  return { title, body, url };
}
const summary = (a) => ({
  id: a.id,
  content: a.content,
  createdAt: a.createdAt,
  users: a.users,
  total: a.targets.length,
  pending: a.targets.filter((t) => t.state === 'PENDING').length,
  sent: a.targets.filter((t) => t.state === 'SENT').length,
  failed: a.targets.filter((t) => t.state === 'FAILED').length,
  skipped: a.targets.filter((t) => t.state === 'SKIPPED').length,
  uncertain: a.targets.filter((t) => t.state === 'SENDING').length,
});
async function locked(db, id, change) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw bad('Annonce invalide.');
  const key = PREFIX + id;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT key FROM "AppSetting" WHERE key=${key} FOR UPDATE`;
    const row = await tx.appSetting.findUnique({ where: { key } });
    if (!row) throw bad('Annonce introuvable.', 404);
    const a = row.value;
    const result = await change(a, tx);
    await tx.appSetting.update({ where: { key }, data: { value: a } });
    return result;
  });
}
async function prepare(db, actorId, input) {
  const message = content(input);
  const subs = await db.pushSubscription.findMany({
    where: { enabled: true, createdAt: { gte: new Date(push.DOMAIN_SWITCH) } },
    select: { id: true, userId: true },
  });
  const id = randomUUID();
  const a = {
    id,
    actorId,
    createdAt: new Date().toISOString(),
    content: message,
    users: new Set(subs.map((s) => s.userId)).size,
    targets: subs.map((s) => ({ id: s.id, state: 'PENDING' })),
  };
  await db.$transaction(async (tx) => {
    await tx.appSetting.create({ data: { key: PREFIX + id, value: a } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'ANNONCE_PREPAREE',
        targetType: 'Notification',
        targetId: 0,
        after: { id, ...message, devices: subs.length, users: a.users },
      },
    });
  });
  return summary(a);
}
async function dispatch(db, actorId, id, sender = push.send) {
  const claimed = await locked(db, id, async (a, tx) => {
    if (Date.now() - Date.parse(a.createdAt) > 86400000)
      throw bad('Cette annonce a expiré. Préparez-en une nouvelle.', 409);
    const rows = a.targets.filter((t) => t.state === 'PENDING').slice(0, 3);
    rows.forEach((t) => {
      t.state = 'SENDING';
    });
    if (rows.length && !a.confirmedAt) {
      a.confirmedAt = new Date().toISOString();
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'ANNONCE_CONFIRMEE',
          targetType: 'Notification',
          targetId: 0,
          after: { id, title: a.content.title },
        },
      });
    }
    return { rows, content: a.content };
  });
  for (const target of claimed.rows) {
    let state = 'SKIPPED';
    const sub = await db.pushSubscription.findUnique({ where: { id: target.id } });
    if (sub?.enabled && !isQuiet(sub.preferences)) {
      try {
        await sender(sub, { ...claimed.content, tag: 'pronos-announcement-' + id }, 86400, 'normal');
        state = 'SENT';
      } catch (e) {
        state = 'FAILED';
        if ([404, 410].includes(e.statusCode))
          await db.pushSubscription.update({ where: { id: sub.id }, data: { enabled: false } });
      }
    }
    await locked(db, id, (a) => {
      a.targets.find((t) => t.id === target.id).state = state;
    });
  }
  return locked(db, id, (a) => summary(a));
}
module.exports = { content, summary, prepare, dispatch, locked, PREFIX };
