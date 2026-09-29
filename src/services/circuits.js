// Circuits : classements cumulés sur une série de tournois de la saison (ex. « Circuit national »),
// avec possibilité de retirer les plus mauvais résultats de chaque joueur.
const { failure } = require('./ftlClient');
const { rankRows } = require('./ranking');
const { standings } = require('./standings');

const KEY = 'circuits';

async function getCircuits(db) {
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  return Array.isArray(row?.value) ? row.value : [];
}

async function validateCircuits(db, input) {
  if (!Array.isArray(input) || input.length > 20) throw failure('Liste de circuits invalide (20 au plus).', 400);
  const known = new Set((await db.tournament.findMany({ select: { id: true } })).map((t) => t.id));
  const names = new Set();
  return input.map((c, i) => {
    const name = String(c?.name || '')
      .normalize('NFC')
      .trim();
    if (!name || name.length > 60) throw failure(`Circuit ${i + 1} : nom requis (60 caractères au plus).`, 400);
    if (names.has(name.toLowerCase())) throw failure(`Deux circuits portent le nom « ${name} ».`, 400);
    names.add(name.toLowerCase());
    const tournamentIds = [...new Set((c.tournamentIds || []).map(Number))];
    if (!tournamentIds.length || tournamentIds.length > 30 || tournamentIds.some((t) => !known.has(t)))
      throw failure(`Circuit « ${name} » : choisissez de 1 à 30 tournois existants.`, 400);
    const dropWorst = Number(c.dropWorst || 0);
    if (!Number.isInteger(dropWorst) || dropWorst < 0 || dropWorst >= tournamentIds.length)
      throw failure(`Circuit « ${name} » : résultats retirés entre 0 et ${tournamentIds.length - 1}.`, 400);
    const id = Number.isSafeInteger(c.id) && c.id > 0 ? c.id : null;
    return { id, name, tournamentIds, dropWorst };
  });
}

async function saveCircuits(db, input, actorId) {
  const circuits = await validateCircuits(db, input);
  let next = Math.max(0, ...circuits.map((c) => c.id || 0)) + 1;
  for (const c of circuits) if (!c.id) c.id = next++;
  const before = await getCircuits(db);
  await db.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: circuits },
    update: { value: circuits },
  });
  await db.auditLog.create({
    data: { actorId, action: 'Circuits mis à jour', targetType: 'Circuit', targetId: 0, before, after: circuits },
  });
  return circuits;
}

// Classement d'un circuit : points de chaque tournoi (classement du tournoi), meilleurs résultats retenus.
async function circuitRanking(db, circuitId) {
  const circuit = (await getCircuits(db)).find((c) => c.id === circuitId);
  if (!circuit) throw failure('Circuit introuvable.', 404);
  const tournaments = await db.tournament.findMany({
    where: { id: { in: circuit.tournamentIds } },
    select: { id: true, name: true },
  });
  const perTournament = await Promise.all(circuit.tournamentIds.map((id) => standings(db, { tournamentId: id })));
  const players = new Map();
  perTournament.forEach((rows, i) => {
    for (const r of rows) {
      if (!players.has(r.id))
        players.set(r.id, { id: r.id, name: r.name, results: new Array(circuit.tournamentIds.length).fill(0) });
      players.get(r.id).results[i] = r.totalPoints || 0;
    }
  });
  const keep = circuit.tournamentIds.length - circuit.dropWorst;
  const rows = [...players.values()]
    .map((p) => {
      const kept = [...p.results].sort((a, b) => b - a).slice(0, keep);
      return { ...p, totalPoints: kept.reduce((a, b) => a + b, 0), played: p.results.filter((x) => x !== 0).length };
    })
    .filter((p) => p.played > 0);
  return {
    circuit: {
      ...circuit,
      tournaments: circuit.tournamentIds.map(
        (id) => tournaments.find((t) => t.id === id) || { id, name: `Tournoi ${id}` },
      ),
    },
    rows: rankRows(rows),
  };
}

module.exports = { getCircuits, saveCircuits, validateCircuits, circuitRanking };
