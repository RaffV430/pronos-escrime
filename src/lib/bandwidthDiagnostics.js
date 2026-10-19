// Octets du corps HTTP après compression. Aucune URL réelle, requête, identité ou donnée métier journalisée.
function bandwidthDiagnostics({
  log = console.info,
  intervalMs = 60000,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const totals = new Map();
  const prefixes = new Set([
    '/api/auth',
    '/api/support',
    '/api/clubs',
    '/api/matches',
    '/api/podium',
    '/api/pools',
    '/api/notifications',
    '/api/admin',
    '/api/admin/fencer-affiliations',
    '/api/community',
    '/api/me/fencers',
    '/api/me',
    '/api/results',
    '/api/public',
  ]);
  function flush() {
    if (!totals.size) return;
    log(JSON.stringify({ event: 'http_body_bytes', routes: [...totals.values()] }));
    totals.clear();
  }
  const timer = setTimer(flush, intervalMs);
  timer.unref?.();
  const middleware = (req, res, next) => {
    const write = res.write;
    const end = res.end;
    const count = (chunk, encoding) => {
      if (chunk == null || typeof chunk === 'function') return;
      const bytes =
        typeof chunk === 'string'
          ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
          : chunk.byteLength || 0;
      const prefix = prefixes.has(req.baseUrl) ? req.baseUrl : '';
      const route = typeof req.route?.path === 'string' ? prefix + req.route.path : '/unclassified';
      // req.route.path est le modèle Express, jamais req.path avec ses identifiants.
      const key = `${req.method} ${route}`;
      const row = totals.get(key) || { method: req.method, route, bytes: 0 };
      row.bytes += bytes;
      totals.set(key, row);
    };
    res.write = function (chunk, encoding, callback) {
      count(chunk, encoding);
      return write.call(this, chunk, encoding, callback);
    };
    res.end = function (chunk, encoding, callback) {
      count(chunk, encoding);
      return end.call(this, chunk, encoding, callback);
    };
    next();
  };
  return {
    middleware,
    flush,
    stop() {
      clearTimer(timer);
      flush();
    },
  };
}
module.exports = { bandwidthDiagnostics };
