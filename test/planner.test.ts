import { describe, expect, it } from 'vitest';
import { planSlots } from '../src/planner';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const T0 = Date.UTC(2026, 10, 10, 9, 0);

function check(all: number[], gap: number, limit: number) {
  const s = [...all].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeGreaterThanOrEqual(gap);
  for (let i = 0; i < s.length; i++) {
    const inWin = s.filter((x) => x >= s[i] && x < s[i] + D).length;
    expect(inWin).toBeLessThanOrEqual(limit);
  }
}

describe('planSlots', () => {
  it('spaces by throttle and caps per 24h', () => {
    const slots = planSlots({ occupied: [], count: 7, start: T0, gapMs: 5 * M, limit: 3 });
    expect(slots.slice(0, 3)).toEqual([T0, T0 + 5 * M, T0 + 10 * M]);
    expect(slots[3]).toBe(T0 + D); // 4th waits for the first to leave the window
    expect(slots[6]).toBe(T0 + 2 * D);
    check(slots, 5 * M, 3);
  });

  it('respects emails already sent in the last 24h', () => {
    const occupied = [T0 - 2 * H, T0 - H];
    const slots = planSlots({ occupied, count: 2, start: T0, gapMs: 5 * M, limit: 3 });
    expect(slots[0]).toBe(T0);
    expect(slots[1]).toBe(T0 - 2 * H + D);
    check([...occupied, ...slots], 5 * M, 3);
  });

  it('fills around existing scheduled emails without breaking their windows', () => {
    const occupied = [T0 + 2 * M, T0 + 3 * H, T0 + 6 * H];
    const slots = planSlots({ occupied, count: 5, start: T0, gapMs: 10 * M, limit: 4 });
    check([...occupied, ...slots], 10 * M, 4);
    expect(slots[0]).toBe(T0 + 12 * M); // pushed past the email at +2m by the throttle
  });

  it('handles large batches across days', () => {
    const slots = planSlots({ occupied: [], count: 500, start: T0, gapMs: 3 * M, limit: 50 });
    expect(slots).toHaveLength(500);
    check(slots, 3 * M, 50);
    expect(slots[499] - T0).toBeLessThan(10 * D);
  });
});
