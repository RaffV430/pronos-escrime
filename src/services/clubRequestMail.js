const mailer = require('./mailer');
const { refusalMessage } = require('./clubRequestEmail');
const workers = new WeakMap();
function wake(db) {
  const tick = workers.get(db);
  if (!tick) return false;
  tick();
  return true;
}
async function deliver(db, transport = mailer, now = new Date()) {
  if (!transport.playerMailAvailable()) return 0;
  const row = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(72610410)::text`;
    await tx.clubRegistrationRequest.updateMany({
      where: { status: 'REJECTED', mailStatus: 'SENDING', mailNextAt: { lte: now }, mailAttempts: { gte: 5 } },
      data: { mailStatus: 'FAILED' },
    });
    const r = await tx.clubRegistrationRequest.findFirst({
      where: {
        status: 'REJECTED',
        mailAttempts: { lt: 5 },
        OR: [
          { mailStatus: 'PENDING', mailNextAt: { lte: now } },
          { mailStatus: 'SENDING', mailNextAt: { lte: now } },
        ],
      },
      include: { user: { select: { email: true } } },
      orderBy: { id: 'asc' },
    });
    if (!r) return null;
    await tx.clubRegistrationRequest.update({
      where: { id: r.id },
      data: { mailStatus: 'SENDING', mailAttempts: { increment: 1 }, mailNextAt: new Date(now.getTime() + 5 * 60000) },
    });
    return r;
  });
  if (!row) return 0;
  try {
    await transport.sendMail({
      to: row.user.email,
      ...refusalMessage(row),
      idempotencyKey: `club-request-refused-${row.id}`,
    });
    await db.clubRegistrationRequest.update({
      where: { id: row.id },
      data: { mailStatus: 'SENT', mailSentAt: new Date() },
    });
    return 1;
  } catch {
    await db.clubRegistrationRequest.update({
      where: { id: row.id },
      data: {
        mailStatus: row.mailAttempts + 1 >= 5 ? 'FAILED' : 'PENDING',
        mailNextAt: new Date(now.getTime() + 10 * 60000),
      },
    });
    return 0;
  }
}
function startWorker(db, deps = {}) {
  let running = null,
    stopped = false,
    requested = false;
  const tick = () => {
    if (stopped) return;
    requested = true;
    if (running) return;
    // A committed request wakes the existing queue; the timer remains a recovery path.
    running = Promise.resolve()
      .then(async () => {
        do {
          requested = false;
          const alerted = await (deps.alertAdmins || alertAdmins)(db);
          const mailed = await (deps.deliver || deliver)(db);
          if (alerted || mailed) requested = true;
        } while (requested && !stopped);
      })
      .catch(() => {})
      .finally(() => {
        running = null;
        if (requested && !stopped) tick();
      });
  };
  workers.set(db, tick);
  const timer = (deps.setInterval || setInterval)(tick, 60000);
  timer.unref();
  tick();
  return () => {
    stopped = true;
    if (workers.get(db) === tick) workers.delete(db);
    (deps.clearInterval || clearInterval)(timer);
    return running;
  };
}
async function alertAdmins(db, notify = require('./syncHealth').notifyAdmins, now = new Date()) {
  const row = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(72610411)::text`;
    await tx.clubRegistrationRequest.updateMany({
      where: {
        status: 'PENDING',
        adminAlertStatus: 'SENDING',
        adminAlertNextAt: { lte: now },
        adminAlertAttempts: { gte: 5 },
      },
      data: { adminAlertStatus: 'FAILED' },
    });
    const r = await tx.clubRegistrationRequest.findFirst({
      where: {
        status: 'PENDING',
        adminAlertStatus: { in: ['PENDING', 'SENDING'] },
        adminAlertAttempts: { lt: 5 },
        adminAlertNextAt: { lte: now },
      },
      orderBy: { id: 'asc' },
    });
    if (!r) return null;
    await tx.clubRegistrationRequest.update({
      where: { id: r.id },
      data: {
        adminAlertStatus: 'SENDING',
        adminAlertAttempts: { increment: 1 },
        adminAlertNextAt: new Date(now.getTime() + 5 * 60000),
      },
    });
    return r;
  });
  if (!row) return 0;
  let sent;
  try {
    sent = await notify(db, {
      title: 'Pronos Escrime — club à valider',
      body: 'Une demande de création de club attend votre décision dans Administration, rubrique Clubs ajoutés à vérifier.',
      tag: `club-request-${row.id}`,
      url: `/admin?panel=clubs&request=${row.id}`,
    });
  } catch {
    sent = {};
  }
  const success = sent.mail > 0 && sent.push > 0 && !sent.mailFailed && !sent.pushFailed;
  await db.clubRegistrationRequest.update({
    where: { id: row.id },
    data: {
      adminAlertStatus: success ? 'SENT' : row.adminAlertAttempts + 1 >= 5 ? 'FAILED' : 'PENDING',
      adminAlertNextAt: new Date(now.getTime() + 10 * 60000),
    },
  });
  return success ? 1 : 0;
}
module.exports = { deliver, startWorker, alertAdmins, wake };
