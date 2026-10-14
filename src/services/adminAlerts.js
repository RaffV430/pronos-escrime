// Same active states as the administration panels; no per-user or owner filter.
async function summary(db, now = Date.now()) {
  const [clubs, sync, discovered] = await Promise.all([
    db.clubRegistrationRequest.count({ where: { status: 'PENDING' } }),
    require('./syncHealth').syncHealth(db, now),
    require('./ftlEventDiscovery').list(db),
  ]);
  const problems = sync.summary.error + sync.summary.warning;
  const events = discovered.reduce((n, t) => n + t.events.length + (t.error ? 1 : 0), 0);
  return { clubs, problems, events, total: clubs + problems + events };
}
module.exports = { summary };
