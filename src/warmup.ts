import type { MailboxRow } from './google';

const DAY = 86_400_000;
export const WARMUP_LIMITS = { MIN_START: 1, MAX_START: 500, MIN_STEP: 1, MAX_STEP: 200, DEFAULT_START: 5, DEFAULT_STEP: 3 };

type WarmupFields = Pick<MailboxRow, 'daily_limit' | 'warmup_enabled' | 'warmup_start' | 'warmup_step' | 'warmup_started_at'>;

const active = (mb: WarmupFields) => !!mb.warmup_enabled && !!mb.warmup_started_at;

/**
 * The daily limit in force at time t. While warming up it starts at warmup_start on day 0 and grows by
 * warmup_step every 24 hours until it reaches the mailbox's daily_limit (the target).
 */
export function dailyLimitAt(mb: WarmupFields, t: number): number {
  const target = Math.max(1, mb.daily_limit || 1);
  if (!active(mb)) return target;
  const day = Math.max(0, Math.floor((t - mb.warmup_started_at!) / DAY));
  return Math.max(1, Math.min(target, (mb.warmup_start || WARMUP_LIMITS.DEFAULT_START) + (mb.warmup_step || WARMUP_LIMITS.DEFAULT_STEP) * day));
}

/** Warm-up status for the UI and API. */
export function warmupInfo(mb: WarmupFields, t = Date.now()) {
  const target = Math.max(1, mb.daily_limit || 1);
  const start = mb.warmup_start || WARMUP_LIMITS.DEFAULT_START;
  const step = mb.warmup_step || WARMUP_LIMITS.DEFAULT_STEP;
  if (!active(mb)) return { enabled: false, start, step, started_at: null, day: null, today_limit: target, target, complete: false, completes_at: null };
  const day = Math.max(0, Math.floor((t - mb.warmup_started_at!) / DAY));
  const daysToTarget = Math.max(0, Math.ceil((target - start) / step));
  return {
    enabled: true,
    start,
    step,
    started_at: new Date(mb.warmup_started_at!).toISOString(),
    day: day + 1,
    today_limit: dailyLimitAt(mb, t),
    target,
    complete: day >= daysToTarget,
    completes_at: new Date(mb.warmup_started_at! + daysToTarget * DAY).toISOString(),
  };
}
