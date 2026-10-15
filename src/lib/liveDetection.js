// Première détection uniquement : une coupure du flux ne rouvre jamais un pronostic.
const detected = new Map();
function rememberLive(match, at) {
  const before = detected.get(match.id);
  if (!before || before.player1 !== match.player1 || before.player2 !== match.player2)
    detected.set(match.id, { player1: match.player1, player2: match.player2, at: new Date(at).toISOString() });
}
function liveDetectedAt(match) {
  if (match.liveDetectedAt) return match.liveDetectedAt;
  const found = detected.get(match.id);
  return found && found.player1 === match.player1 && found.player2 === match.player2 ? found.at : null;
}
module.exports = { rememberLive, liveDetectedAt };
