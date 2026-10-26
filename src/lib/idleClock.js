// Mode veille des tâches de fond : hors compétition, elles passent toutes au même moment, sur une grille de
// 15 minutes (avec un léger décalage chacune), au lieu de toutes les 5 ou 30 secondes. La base Neon peut alors
// s'endormir entre deux passages (elle reste éveillée environ 5 minutes après la dernière requête), ce qui
// réduit son temps de calcul facturé et le trafic sortant du serveur. Dès qu'une épreuve approche ou se déroule,
// chaque tâche reprend son rythme rapide. BACKGROUND_IDLE=false désactive le mode veille (retour à l'ancien rythme).
const DEFAULT_IDLE_MS = 15 * 60000;
const MIN_IDLE_MS = 6 * 60000; // au-delà des 5 minutes d'éveil de Neon, sinon la base ne dort jamais
const idleEnabled = () => process.env.BACKGROUND_IDLE !== 'false';
const idlePeriod = () => {
  const ms = Number(process.env.BACKGROUND_IDLE_MS);
  return Number.isFinite(ms) && ms >= MIN_IDLE_MS ? ms : DEFAULT_IDLE_MS;
};
// Délai jusqu'au prochain créneau commun de la grille (heure ronde + multiples de la période) + décalage.
function untilSlot(offsetMs = 0, now = Date.now(), period = idlePeriod()) {
  const next = Math.floor((now - offsetMs) / period) * period + period + offsetMs;
  return Math.max(1000, next - now);
}
// Réveil immédiat des tâches en veille (écriture d'administration, alerte à envoyer…).
const wakers = new Map();
const registerWake = (name, fn) => {
  wakers.set(name, fn);
  return () => wakers.get(name) === fn && wakers.delete(name);
};
function wakeAll() {
  for (const fn of wakers.values())
    try {
      fn();
    } catch {
      /* un réveil manqué attend simplement le prochain créneau */
    }
}
module.exports = { DEFAULT_IDLE_MS, MIN_IDLE_MS, idleEnabled, idlePeriod, untilSlot, registerWake, wakeAll };
