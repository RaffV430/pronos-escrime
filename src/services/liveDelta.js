// Transport uniquement : aucune règle de score, identité ou verrouillage ne change.
function liveDelta(previous, rows) {
  const next = new Map(rows.map((row) => [row.matchId, row]));
  if (!previous) return { next, message: { version: 1, reset: true, matches: rows, removed: [] } };
  const matches = [];
  for (const row of rows) {
    const before = previous.get(row.matchId);
    if (JSON.stringify(before) === JSON.stringify(row)) continue;
    if (!before) {
      matches.push(row);
      continue;
    }
    const patch = { matchId: row.matchId };
    // Inclure null pour effacer un champ disparu (fin, correction, changement de côté).
    for (const key of new Set([...Object.keys(before), ...Object.keys(row)])) {
      if (key === 'matchId' || key === 'history') continue;
      if (JSON.stringify(before[key]) !== JSON.stringify(row[key])) patch[key] = row[key] ?? null;
    }
    const history = row.history || [];
    const old = before.history || [];
    if (JSON.stringify(history) !== JSON.stringify(old)) {
      const append =
        old.length <= history.length && old.every((touch, i) => JSON.stringify(touch) === JSON.stringify(history[i]));
      if (append) {
        patch.historyFrom = old.length;
        patch.historyAppend = history.slice(old.length);
      } else patch.history = history;
    }
    matches.push(patch);
  }
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  return { next, message: matches.length || removed.length ? { version: 1, reset: false, matches, removed } : null };
}
module.exports = { liveDelta };
