const { lastBeat } = require('../lib/heartbeat');
function workerHealth({
  now = Date.now(),
  uptime = process.uptime(),
  enabled = { ftl: process.env.FTL_AUTO_SYNC === 'true', notifications: require('./pushNotifications').configured() },
  beat = lastBeat,
} = {}) {
  return Object.fromEntries(
    Object.entries(enabled).map(([name, active]) => {
      const at = beat(name === 'notifications' ? 'push' : name);
      return [
        name,
        {
          enabled: active,
          lastRunAt: at ? new Date(at).toISOString() : null,
          stale: Boolean(active && uptime > 120 && (!at || now - at > 300000)),
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
        report(new Error(`Tâche ${name} sans passage réussi depuis plus de cinq minutes.`), 'surveillance des tâches');
      }
      if (!state.stale && alerted.delete(name)) console.info(`Tâche ${name} : suivi rétabli.`);
    }
  };
  const timer = setInterval(run, every);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { workerHealth, startWatchdog };
