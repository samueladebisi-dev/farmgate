// Simple in-memory fixed-window rate limit (per server process). Fine for a prototype.
const hits = new Map<string, { count: number; resetAt: number }>();

/** Returns true if the call is allowed, false if the caller is over the limit. */
export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || h.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  h.count += 1;
  return h.count <= max;
}

export function resetRateLimits() {
  hits.clear();
}
