// Agrégats de transport uniquement. Aucune identité, URL, épreuve ou donnée sportive conservée.
const { performance } = require('node:perf_hooks');
const SESSION = Symbol('anonymousLiveMetrics');
const NOOP = Object.freeze({ message() {}, close() {} });
function createLiveMetrics({
  enabled = false,
  now = () => performance.now(),
  wall = () => new Date().toISOString(),
  log = (row) => console.info(JSON.stringify(row)),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const groups = new Map();
  let timer;
  let stopped = false;
  let windowStart = now();
  let totalActive = 0;
  let totalPeak = 0;
  const fresh = (active = 0) => ({
    active,
    peak: active,
    opened: 0,
    closed: 0,
    connection_ms: 0,
    messages: 0,
    packed_messages: 0,
    json_bytes: 0,
    wire_json_bytes: 0,
    origin_body_bytes: 0,
  });
  const tick = (g) => {
    const at = now();
    g.counts.connection_ms += Math.max(0, at - g.at) * g.counts.active;
    g.at = at;
  };
  const flush = () => {
    if (!enabled || stopped || !groups.size) return;
    const rows = [];
    for (const [format, g] of groups) {
      tick(g);
      rows.push({ format, ...g.counts, connection_ms: Math.round(g.counts.connection_ms) });
      g.counts = fresh(g.counts.active);
    }
    const nextWindow = now();
    // La télémétrie ne doit jamais interrompre un flux ou son nettoyage.
    try {
      log({
        event: 'anonymous_live_minute',
        at: wall(),
        window_ms: Math.max(0, now() - windowStart),
        connections_active: totalActive,
        connections_peak: totalPeak,
        rows,
      });
    } catch {
      /* best effort */
    }
    windowStart = nextWindow;
    totalPeak = totalActive;
  };
  const middleware = (req, res, next) => {
    if (!enabled || stopped) return next();
    const write = res.write;
    const end = res.end;
    const count = (chunk, encoding) => {
      if (chunk == null || typeof chunk === 'function') return;
      const session = res[SESSION];
      if (session)
        session.bytes(
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
            : chunk.byteLength || 0,
        );
    };
    res.write = function (chunk, encoding, callback) {
      const result = write.call(this, chunk, encoding, callback);
      count(chunk, encoding);
      return result;
    };
    res.end = function (chunk, encoding, callback) {
      const result = end.call(this, chunk, encoding, callback);
      count(chunk, encoding);
      return result;
    };
    next();
  };
  const begin = (res, { delta, packedWire }) => {
    if (!enabled || stopped) return NOOP;
    if (res[SESSION]) return res[SESSION];
    const format = `${delta ? 'delta' : 'snapshot'}:${packedWire ? 'packed' : 'plain'}`;
    if (!groups.has(format)) groups.set(format, { at: now(), counts: fresh() });
    const g = groups.get(format);
    tick(g);
    g.counts.active++;
    totalActive++;
    totalPeak = Math.max(totalPeak, totalActive);
    g.counts.opened++;
    g.counts.peak = Math.max(g.counts.peak, g.counts.active);
    let closed = false;
    const session = {
      bytes(size) {
        if (!stopped) g.counts.origin_body_bytes += size;
      },
      message(body, wire) {
        if (closed || stopped) return;
        g.counts.messages++;
        g.counts.packed_messages += Number(body !== wire);
        g.counts.json_bytes += Buffer.byteLength(body);
        g.counts.wire_json_bytes += Buffer.byteLength(wire);
      },
      close() {
        if (closed || stopped) return;
        closed = true;
        tick(g);
        g.counts.active--;
        totalActive--;
        g.counts.closed++;
        res.removeListener('finish', session.close);
        res.removeListener('close', session.close);
        res.removeListener('error', session.close);
      },
    };
    res[SESSION] = session;
    res.once('finish', session.close);
    res.once('close', session.close);
    res.once('error', session.close);
    return session;
  };
  if (enabled) {
    timer = setTimer(flush, 60000);
    timer.unref?.();
  }
  return {
    middleware,
    begin,
    flush,
    stop() {
      if (!stopped) {
        flush();
        stopped = true;
        if (timer) clearTimer(timer);
      }
    },
  };
}
const liveMetrics = createLiveMetrics({ enabled: process.env.LIVE_METRICS === 'true' });
module.exports = { createLiveMetrics, liveMetrics };
