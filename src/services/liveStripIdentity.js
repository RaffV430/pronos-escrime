const { norm } = require('./ftlParser');

// Explicit source spelling variant only. Never guess between numbered or unknown strips.
function liveStripIdentity(value) {
  const key = norm(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return key === 'podiom' ? 'podium' : key;
}
module.exports = { liveStripIdentity };
