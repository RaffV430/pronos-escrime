// Dernier passage réussi de chaque tâche de fond, pour la page de santé (/health). Une tâche en veille annonce
// aussi le délai prévu avant son prochain passage, pour ne pas être jugée bloquée pendant sa veille.
const beats = new Map();
const beat = (name, nextInMs = null) =>
  beats.set(name, { at: Date.now(), next: Number.isFinite(nextInMs) ? nextInMs : null });
const lastBeat = (name) => beats.get(name)?.at || null;
const nextExpected = (name) => beats.get(name)?.next ?? null;
module.exports = { beat, lastBeat, nextExpected };
