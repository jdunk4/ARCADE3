// perfProbe.js — performance instrumentation toggle for diagnosing
// first-spawn / first-event freezes (flinger spawn, pixl-pal spawn,
// first grenade, first damage, etc.)
//
// USAGE:
//   import { probe, probeAsync, installLongTaskObserver } from './perfProbe.js';
//
//   probe('flinger:summon', () => { ... synchronous block ... });
//   const result = await probeAsync('flinger:loadGLB', async () => { ... });
//
// On the first call to any tag, the result prints with a 🐢 SLOW / 🟢 OK
// flag (>50ms = SLOW). The result also stays in performance.measure
// records so the DevTools Performance panel can visualize them on the
// timeline alongside frame data.
//
// Set ENABLED = false to disable all probes with zero runtime cost
// (the wrappers still execute the inner function but skip timing).
//
// REMOVE-ME: when the source of the freeze has been identified and
// fixed, this module + every probe() call site can be deleted in one
// pass. Search for "perfProbe" or "probe(".

// Master switch — flip to false to silence all probes.
const ENABLED = true;

// Threshold in milliseconds for the SLOW flag. Anything above this
// blocks the main thread visibly (>1 frame at 60fps).
const SLOW_MS = 16;

// Tags we've seen — first-time-only flag means we can highlight the
// initial run of each tag (which is when the freeze happens).
const _firstSeen = new Set();

/**
 * Wrap a synchronous block in a high-resolution timer. Logs duration,
 * marks first-time tags, flags slow runs.
 *
 * Returns the wrapped function's return value so it can be inlined:
 *   const x = probe('foo', () => doFoo());
 */
export function probe(tag, fn) {
  if (!ENABLED) return fn();
  const t0 = performance.now();
  let ok = true;
  let result;
  try {
    result = fn();
  } catch (e) {
    ok = false;
    _logProbe(tag, performance.now() - t0, /*first*/ false, /*err*/ true);
    throw e;
  }
  const dt = performance.now() - t0;
  const first = !_firstSeen.has(tag);
  if (first) _firstSeen.add(tag);
  _logProbe(tag, dt, first, false);
  return result;
}

/**
 * Async variant — awaits the inner promise and times the full async
 * span (including any awaits inside).
 */
export async function probeAsync(tag, fn) {
  if (!ENABLED) return await fn();
  const t0 = performance.now();
  let result;
  try {
    result = await fn();
  } catch (e) {
    _logProbe(tag, performance.now() - t0, /*first*/ false, /*err*/ true);
    throw e;
  }
  const dt = performance.now() - t0;
  const first = !_firstSeen.has(tag);
  if (first) _firstSeen.add(tag);
  _logProbe(tag, dt, first, false);
  return result;
}

function _logProbe(tag, dt, first, err) {
  const slow = dt >= SLOW_MS;
  const firstFlag = first ? '🆕FIRST ' : '';
  const slowFlag = slow ? '🐢SLOW ' : '🟢OK    ';
  const errFlag = err ? '❌ERR ' : '';
  const dtStr = dt.toFixed(1).padStart(7, ' ');
  // Bright styling so the freezes stand out in a noisy console
  const style = slow
    ? 'color:#ff5555;font-weight:bold;'
    : (first ? 'color:#44ddff;' : 'color:#888;');
  // eslint-disable-next-line no-console
  console.log(
    `%c[perf] ${firstFlag}${slowFlag}${errFlag}${dtStr}ms  ${tag}`,
    style,
  );
}

/**
 * Install a PerformanceObserver that flags any task on the main thread
 * taking longer than `thresholdMs` (default 50). Captures things our
 * explicit probe() calls miss — e.g. shader compiles in renderer.compile,
 * GC pauses, hidden async work, browser layout/paint hitches.
 *
 * Call once at startup. Safe no-op on browsers without the API.
 */
export function installLongTaskObserver(thresholdMs = 50) {
  if (!ENABLED) return;
  if (typeof PerformanceObserver === 'undefined') {
    console.warn('[perf] PerformanceObserver unavailable on this browser');
    return;
  }
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < thresholdMs) continue;
        // eslint-disable-next-line no-console
        console.log(
          `%c[perf-longtask] 🚨 ${entry.duration.toFixed(0)}ms  ${entry.name}` +
          (entry.attribution && entry.attribution.length
            ? ` (${entry.attribution.map(a => a.name || a.containerType).join(',')})`
            : ''),
          'color:#ff8800;font-weight:bold;background:#220;padding:2px 4px;',
        );
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    console.log('%c[perf] long-task observer installed (threshold ' + thresholdMs + 'ms)', 'color:#888;');
  } catch (e) {
    console.warn('[perf] longtask observer failed:', e.message);
  }
}
