// Same active states as the administration panels; no per-user or owner filter.
async function summary(db, now = Date.now()) {
  const [clubs, sync] = await Promise.all([
    db.clubRegistrationRequest.count({ where: { status: 'PENDING' } }),
    require('./syncHealth').syncHealth(db, now),
  ]);
  const problems = sync.summary.error + sync.summary.warning;
  return { clubs, problems, total: clubs + problems };
}
module.exports = { summary };
