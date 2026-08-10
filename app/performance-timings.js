import { performance } from "node:perf_hooks";

export function measurePhase(timings, name, operation) {
  const startedAt = performance.now();
  const value = operation();
  timings[name] = performance.now() - startedAt;
  return value;
}

export function emitPerformanceTimings(scope, timings) {
  if (!process.env.KHAZAI_DEBUG_PERF) return;
  const phases = Object.fromEntries(Object.entries(timings)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => [name, Math.round(value * 100) / 100]));
  process.stderr.write(`[khazai:performance] ${JSON.stringify({ scope, phases })}\n`);
}

export function emitRequestMetrics(scope, metrics) {
  if (!process.env.KHAZAI_DEBUG_PERF) return;
  const entries = Object.fromEntries(Object.entries(metrics)
    .filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => [name, Math.round(value * 100) / 100]));
  process.stderr.write(`[khazai:performance] ${JSON.stringify({ scope, metrics: entries })}\n`);
}
