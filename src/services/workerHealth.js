const { lastBeat, nextExpected } = require('../lib/heartbeat');
function workerHealth({
  now = Date.now(),
  uptime = process.uptime(),
  enabled = { ftl: process.env.FTL_AUTO_SYNC === 'true', notifications: require('./pushNotifications').configured() },
  beat = lastBeat,
  expected = nextExpected,
} = {}) {
  return Object.fromEntries(
    Object.entries(enabled).map(([name, active]) => {
      const key = name === 'notifications' ? 'push' : name;
      const at = beat(key);
      // En veille, une tâche peut ne repasser que dans 15 minutes : marge de 2 minutes après le passage annoncé.
      const limit = Math.max(300000, (expected(key) || 0) + 120000);
      return [
        name,
        {
          enabled: active,
          lastRunAt: at ? new Date(at).toISOString() : null,
          stale: Boolean(active && uptime > 120 && (!at || now - at > limit)),
        },
      ];
    }),
  );
}
function startWatchdog({ inspect = workerHealth, report = require('../lib/report').reportError, every = 60000 } = {}) {
  const alerted = new Set();
  const run = () => {
    for (const [name, state] of Object.entries(inspect())) {
      if (state.stale && !alerted.has(name)) {
        alerted.add(name);
        report(new Error(`Tâche ${name} sans passage réussi dans le délai prévu.`), 'surveillance des tâches');
      }
      if (!state.stale && alerted.delete(name)) console.info(`Tâche ${name} : suivi rétabli.`);
    }
  };
  const timer = setInterval(run, every);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { workerHealth, startWatchdog };
