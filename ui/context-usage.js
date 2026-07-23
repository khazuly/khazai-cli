export function formatContextUsage(usage = {}) {
  const budget = Math.max(1, Number(usage.budget) || 1);
  const used = Math.max(0, Number(usage.used) || 0);
  return `${Math.min(100, Math.floor((used / budget) * 100))}/100%`;
}
