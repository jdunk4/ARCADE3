// perfProbe.js — performance instrumentation toggle for diagnosing
// first-spawn / first-event freezes (flinger spawn, pixl-pal spawn,
// first grenade, first damage, etc.)
//
// USAGE:
//   import { probe, probeAsync, installLongTaskObserver, getLastSlowTag } from './perfProbe.js';
//
//   probe('flinger:summon', () => { ... synchronous block ... });
//   const result = await probeAsync('flinger:loadGLB', async () => { ... });
//
// On the first call to any tag, the result prints with a 🐢 SLOW / 🟢 OK
// flag (>16ms = SLOW). Output uses console.warn so the messages appear
// alongside the existing [long-frame] warnings rather than being
// filtered out by a noisy default-level console.
//
// Set ENABLED = false to disable all probes with zero runtime cost.
//
// REMOVE-ME: when the source of the freeze has been identified and
// fixed, this module + every probe() call site can be deleted in one
// pass. Search for "perfProbe" or "probe(".

const ENABLED = true;
const SLOW_MS = 16;

const _firstSeen = new Set();

// The most-recent tag that exceeded SLOW_MS. The long-frame logger
// in main.js reads this as a "what was the last expensive thing?"
// breadcrumb, replacing the previous logger that always blamed
// damage events even when the freeze happened during something else.
let _lastSlowTag = null;
let _lastSlowMs = 0;
let _lastSlowAt = 0;
export function getLastSlowTag() {
  if (!_lastSlowTag) return null;
  return {
    tag: _lastSlowTag,
    ms: _lastSlowMs,
    agoMs: performance.now() - _lastSlowAt,
  };
}

export function probe(tag, fn) {
  if (!ENABLED) return fn();
  const t0 = performance.now();
  let result;
  try {
    result = fn();
  } catch (e) {
    _logProbe(tag, performance.now() - t0, false, true);
    throw e;
  }
  const dt = performance.now() - t0;
  const first = !_firstSeen.has(tag);
  if (first) _firstSeen.add(tag);
  _logProbe(tag, dt, first, false);
  return result;
}

export async function probeAsync(tag, fn) {
  if (!ENABLED) return await fn();
  const t0 = performance.now();
  let result;
  try {
    result = await fn();
  } catch (e) {
    _logProbe(tag, performance.now() - t0, false, true);
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
  if (slow) {
    _lastSlowTag = tag;
    _lastSlowMs = dt;
    _lastSlowAt = performance.now();
  }
  // Skip log entirely if not slow and not first — keeps the console
  // quiet when everything is healthy. Anything noteworthy
  // (first-time call, slow run, error) does log.
  if (!slow && !first && !err) return;
  const firstFlag = first ? '🆕FIRST ' : '';
  const slowFlag = slow ? '🐢SLOW ' : '🟢OK    ';
  const errFlag = err ? '❌ERR ' : '';
  const dtStr = dt.toFixed(1).padStart(7, ' ');
  // console.warn so the entry sits in the same level/visibility as
  // the [long-frame] warnings the user is already seeing.
  console.warn(
    `[perf] ${firstFlag}${slowFlag}${errFlag}${dtStr}ms  ${tag}`,
  );
}

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
        console.warn(
          `[perf-longtask] 🚨 ${entry.duration.toFixed(0)}ms  ${entry.name}` +
          (entry.attribution && entry.attribution.length
            ? ` (${entry.attribution.map(a => a.name || a.containerType).join(',')})`
            : ''),
        );
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
    console.warn('[perf] long-task observer installed (threshold ' + thresholdMs + 'ms)');
  } catch (e) {
    console.warn('[perf] longtask observer failed:', e.message);
  }
}
