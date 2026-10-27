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
// Base endormie qui se réveille (Neon met parfois plus de 5 s) : connexion impossible ou coupée, transaction
// expirée pendant l'attente. Ces échecs passagers sont retentés 15 s, 30 s puis 60 s plus tard au lieu
// d'attendre le créneau de veille suivant ; on ne les signale qu'après trois échecs de suite.
const WAKING_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);
const dbWaking = (error) =>
  WAKING_CODES.has(error?.code) ||
  /Can't reach database server|Server has closed the connection|Transaction already closed/.test(
    String(error?.message || ''),
  );
const WAKE_RETRIES = 3;
const retryDelay = (failures) => Math.min(60000, 15000 * 2 ** Math.max(0, failures - 1));
module.exports = {
  DEFAULT_IDLE_MS,
  MIN_IDLE_MS,
  idleEnabled,
  idlePeriod,
  untilSlot,
  registerWake,
  wakeAll,
  dbWaking,
  WAKE_RETRIES,
  retryDelay,
};
