// Observed history. Never reconstruct unobserved touches.
function mergeTeamHistory(previous, segment, current, limit = 150) {
  // Discard a pre-bout zero placeholder when the source subsequently identifies an earlier relay.
  const placeholder = previous.every((e) => e.by === 'start' && e.score1 === 0 && e.score2 === 0);
  const history = (placeholder && previous[0]?.period > (segment[0]?.period || current.period) ? [] : previous).map(
    (x) => ({ ...x }),
  );
  let last = history.at(-1);
  if (last && Date.parse(current.at) < Date.parse(last.at)) return history;
  const cutoff = last ? Date.parse(last.at) : -Infinity;
  const metadata = { fencer1Name: current.fencer1Name, fencer2Name: current.fencer2Name };
  const add = (event) => {
    history.push(event);
    last = event;
  };
  const incoming = segment.filter((x) => Date.parse(x.at) > cutoff);
  for (const event of incoming) {
    if (
      last &&
      (event.period !== last.period ||
        metadata.fencer1Name !== last.fencer1Name ||
        metadata.fencer2Name !== last.fencer2Name)
    ) {
      add({ ...event, ...metadata, by: 'relay', score1: last.score1, score2: last.score2 });
    }
    if (last && event.by === 'start' && event.score1 === last.score1 && event.score2 === last.score2) continue;
    const dl = last ? event.score1 - last.score1 : 0,
      dr = last ? event.score2 - last.score2 : 0;
    const by = event.by === 'double' || (last && (event.by === 'start' || dl > 1 || dr > 1)) ? 'gap' : event.by;
    add({ ...event, ...metadata, by });
  }
  // A relay can change before the next scoring event arrives.
  if (
    last &&
    Date.parse(current.at) > Date.parse(last.at) &&
    (current.period !== last.period ||
      metadata.fencer1Name !== last.fencer1Name ||
      metadata.fencer2Name !== last.fencer2Name)
  ) {
    add({ ...current, score1: last.score1, score2: last.score2, by: 'relay' });
  }
  if (last && (current.score1 !== last.score1 || current.score2 !== last.score2)) {
    add({ ...current, by: current.score1 < last.score1 || current.score2 < last.score2 ? 'correction' : 'gap' });
  }
  if (!history.length) add({ ...current, by: 'start' });
  if (history.length > limit) {
    const kept = history.slice(-(limit - 1));
    return [{ ...history[history.length - limit], by: 'start', truncated: true }, ...kept];
  }
  return history;
}
module.exports = { mergeTeamHistory };
