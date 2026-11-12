/** Sending limits shared by the scheduler, the sender and validation. */
export const LIMITS = {
  DEFAULT_DAILY_LIMIT: 50,
  DEFAULT_THROTTLE_MINUTES: 5,
  MAX_DAILY_LIMIT: 2000, // Google Workspace's own cap
  MAX_THROTTLE_MINUTES: 1440,
  WINDOW_MS: 24 * 3600_000, // "per day" = any rolling 24h window, same rule the sender enforces
  /** Extra room the planner leaves so cron jitter never makes the sender hold a planned email. */
  PLAN_SLACK_MS: 2 * 60_000,
};

/** First index i with a[i] >= x (a sorted ascending). */
function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface PlanInput {
  /** Send times already taken by this mailbox (sent in the last 24h, plus everything still scheduled). */
  occupied: number[];
  count: number;
  start: number;
  gapMs: number;
  limit: number;
  windowMs?: number;
  /** Extra spacing after the k-th new email (uneven gaps for cold outreach). */
  jitterMs?: (k: number) => number;
  /** The daily limit in force at time t, if it changes over time (warm-up). Defaults to `limit`. */
  limitAt?: (t: number) => number;
}

/**
 * Earliest send times for `count` new emails such that, together with `occupied`:
 *  - no two sends are closer than `gapMs`, and
 *  - no 24h window holds more than `limit` sends.
 * Existing scheduled emails keep their times; new ones fill the gaps around them.
 */
export function planSlots({ occupied, count, start, gapMs, limit, windowMs = LIMITS.WINDOW_MS, jitterMs, limitAt }: PlanInput): number[] {
  if (limit < 1) throw new Error('limit must be >= 1');
  const gap = Math.max(0, gapMs);
  const W = windowMs;
  const occ = [...occupied].sort((a, b) => a - b);
  const out: number[] = [];
  let t = start;
  for (let k = 0; k < count; k++) {
    for (let guard = 0; ; guard++) {
      if (guard > 100_000) throw new Error('planner did not converge');
      // Throttle: nothing within `gap` on either side.
      if (gap > 0) {
        const i = lowerBound(occ, t - gap + 1);
        if (i < occ.length && occ[i] < t + gap) {
          t = occ[i] + gap;
          continue;
        }
      }
      // Daily limit: every 24h window containing t must have room for one more.
      const lo = lowerBound(occ, t - W + 1); // first point > t - W
      const mid = lowerBound(occ, t + 1); // first point > t
      let worst = 0;
      // windows [a, a + W) with a in (t - W, t]; the fullest ones start at an existing point or at t
      for (let j = lo; j <= mid; j++) {
        const a = j < mid ? occ[j] : t;
        const inWindow = mid - j + (lowerBound(occ, a + W) - mid);
        if (inWindow > worst) worst = inWindow;
      }
      // A warm-up limit only grows, so checking every window against the limit at t is safe.
      if (worst + 1 > Math.max(1, limitAt ? limitAt(t) : limit)) {
        const hi = lowerBound(occ, t + W);
        t = mid > lo ? occ[lo] + W : occ[hi - 1] + Math.max(gap, 1);
        continue;
      }
      break;
    }
    occ.splice(lowerBound(occ, t), 0, t);
    out.push(t);
    t += Math.max(gap, 1) + Math.max(0, jitterMs ? jitterMs(k) : 0);
  }
  return out;
}

/** Validate a mailbox limit value: integer within [min, max]. */
export function checkLimit(name: string, v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (v === null || v === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}
