function rankRows(rows, score = 'totalPoints') {
  const sorted = [...rows].sort(
    (a, b) =>
      b[score] - a[score] ||
      String(a.name || a.user?.name || '').localeCompare(String(b.name || b.user?.name || ''), 'fr'),
  );
  let rank = 0,
    last;
  return sorted.map((row, i) => {
    if (row[score] !== last) rank = i + 1;
    last = row[score];
    return { ...row, rank };
  });
}
module.exports = { rankRows };
