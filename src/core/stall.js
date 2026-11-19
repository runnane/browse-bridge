/**
 * Evidence for main-process stalls (BBR-4). The tunnel's proxy runs in the Electron main
 * process, so a blocked main process is an outage. Nothing here fixes a stall; it makes the
 * next one leave a trace in app.log.
 */

const defaultClock = () => performance.now();

/**
 * Run a synchronous call and time it.
 *
 * With `trace: true` a "begin" line is written BEFORE the call. Logger writes with
 * appendFileSync, so a call that never returns still leaves that line on disk (a begin with
 * no matching end is the evidence). Without `trace`, only a call slower than `thresholdMs`
 * is logged, after it returns. A call that throws is logged and the error rethrown.
 */
export function timed(logger, label, fn, { trace = false, thresholdMs = 50, clock = defaultClock } = {}) {
  if (trace) logger.info('stall', `${label}: begin`);
  const t0 = clock();
  try {
    return fn();
  } catch (err) {
    logger.warn('stall', `${label}: threw after ${Math.round(clock() - t0)} ms: ${err.message}`);
    throw err;
  } finally {
    const ms = Math.round(clock() - t0);
    if (trace || ms >= thresholdMs) logger.log(ms >= thresholdMs ? 'warn' : 'info', 'stall', `${label}: end, ${ms} ms`);
  }
}

/**
 * Event-loop lag monitor: a repeating timer that measures how late each tick fires and logs
 * a warning when the lag passes `thresholdMs`. The timer is unref'd so it never keeps the
 * process alive. `clock`, `setTimer` and `clearTimer` are injectable for tests.
 */
export function createLagMonitor(logger, {
  intervalMs = 500,
  thresholdMs = 1000,
  clock = defaultClock,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let handle = null;
  let last = 0;
  const tick = () => {
    const now = clock();
    const lag = Math.round(now - last - intervalMs);
    last = now;
    if (lag >= thresholdMs) logger.warn('stall', `main process stalled ${lag} ms`);
  };
  return {
    start() {
      if (handle) return;
      last = clock();
      handle = setTimer(tick, intervalMs);
      handle?.unref?.();
    },
    stop() {
      if (!handle) return;
      clearTimer(handle);
      handle = null;
    },
  };
}
