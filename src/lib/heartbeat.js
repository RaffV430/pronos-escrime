// Dernier passage réussi de chaque tâche de fond, pour la page de santé (/health).
const beats = new Map();
const beat = (name) => beats.set(name, Date.now());
const lastBeat = (name) => beats.get(name) || null;
module.exports = { beat, lastBeat };
