const mailer = require('./mailer');
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
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
    const text = `Votre demande d’ajout du club « ${row.name} » a été refusée.\n\nMotif : ${row.reason}\n\nVous pouvez consulter votre rattachement actuel ou choisir un club existant dans Mon compte. Pour demander un réexamen, contactez l’éditeur depuis les mentions légales du site.`;
    await transport.sendMail({
      to: row.user.email,
      subject: 'Pronos Escrime — demande de club refusée',
      text,
      html: `<p>${escape(text).replace(/\n/g, '<br>')}</p>`,
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
function startWorker(db) {
  let running = null,
    stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = deliver(db)
      .catch(() => {})
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    return running;
  };
}
module.exports = { deliver, startWorker };
