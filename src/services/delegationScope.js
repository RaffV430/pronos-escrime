const SCOPES = ['ALL', 'POOLS', 'TABLEAU', 'PODIUM', 'POOLS,TABLEAU', 'POOLS,PODIUM', 'TABLEAU,PODIUM'];
const includesSection = (scope, section) => scope === 'ALL' || scope.split(',').includes(section);
function validateScope(value = 'ALL') {
  if (!SCOPES.includes(value)) {
    const error = new Error('Choisissez au moins une section : Poules, Tableau ou Podium.');
    error.status = 400;
    throw error;
  }
  return value;
}
function scopeOfMember(league, userId) {
  return league.kind === 'PRIVATE'
    ? league.members.find((m) => m.userId === userId && !m.leftAt)?.predictionScope || 'ALL'
    : 'ALL';
}
function scopedRow(row, scope) {
  if (scope === 'ALL') return { ...row, predictionScope: scope };
  const fields = [
    ...(includesSection(scope, 'POOLS') ? ['poolPoints'] : []),
    ...(includesSection(scope, 'TABLEAU') ? ['matchPoints', 'outsiderPoints'] : []),
    ...(includesSection(scope, 'PODIUM') ? ['podiumPoints'] : []),
  ];
  return { ...row, predictionScope: scope, totalPoints: fields.reduce((total, key) => total + (row[key] || 0), 0) };
}
async function setPreference(db, leagueId, userId, value) {
  const predictionScope = validateScope(value);
  const league = await db.league.findUnique({ where: { id: leagueId }, include: { members: true } });
  if (!league || league.archivedAt || !league.members.some((m) => m.userId === userId && !m.leftAt)) {
    const error = new Error('Ce groupe est privé.');
    error.status = 403;
    throw error;
  }
  if (league.kind !== 'PRIVATE') {
    const error = new Error('Ce choix concerne les délégations d’amis.');
    error.status = 400;
    throw error;
  }
  const result = await db.leagueMember.updateMany({
    where: { leagueId, userId, leftAt: null },
    data: { predictionScope },
  });
  if (!result.count) {
    const error = new Error('Ce groupe est privé.');
    error.status = 403;
    throw error;
  }
  return { predictionScope };
}
module.exports = { validateScope, scopeOfMember, scopedRow, setPreference, includesSection };
