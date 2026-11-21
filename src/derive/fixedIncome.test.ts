import { describe, expect, it } from 'vitest';
import { accruedPer100, addMonths, bondAnalytics, couponSchedule } from './fixedIncome.ts';

// Expected values come from an independent Python implementation (bisection solver).
describe('schedule helpers', () => {
  it('adds months with clamping and end-of-month rule', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2035-02-28', -6, true)).toBe('2034-08-31');
    expect(addMonths('2029-11-12', -12)).toBe('2028-11-12');
  });
  it('builds the coupon schedule around settlement', () => {
    expect(couponSchedule('2029-11-12', 1, '2026-09-30')).toEqual({
      previous: '2025-11-12',
      next: '2026-11-12',
      remaining: ['2026-11-12', '2027-11-12', '2028-11-12', '2029-11-12'],
    });
    expect(couponSchedule('2026-01-01', 1, '2026-09-30')).toBeUndefined();
  });
  it('accrued interest per day count', () => {
    const s = couponSchedule('2029-11-12', 1, '2026-09-30')!;
    expect(accruedPer100(0.75, s, '2026-09-30', 1, 'ACT/ACT ICMA')).toBeCloseTo(0.6616438356, 9);
    expect(accruedPer100(0.75, s, '2026-09-30', 1, 'ACT/365F')).toBeCloseTo((0.75 * 322) / 365, 9);
    expect(accruedPer100(0.75, s, '2026-09-30', 1, 'ACT/360')).toBeCloseTo((0.75 * 322) / 360, 9);
    expect(accruedPer100(0.75, s, '2026-09-30', 1, '30E/360')).toBeCloseTo((0.75 * 318) / 360, 9);
  });
});

describe('bondAnalytics', () => {
  it.each([
    // coupon, maturity, price, freq, AI, yield, macaulay, modified
    [5, '2036-09-30', 100, 1, 0, 0.05, 8.107821675644056, 7.721734929184817],
    [0.75, '2029-11-12', 94.125, 1, 0.6616438356164384, 0.027413483377031533, 3.0713203793798347, 2.989371298967806],
    [4.125, '2032-11-15', 98.4375, 2, 1.546875, 0.04418168116502108, 5.3849939318483395, 5.268605996683544],
    [0, '2031-02-15', 87.25, 1, 0, 0.03164385880625964, 4.3780821917808215, 4.243792229662286],
    [2.5, '2035-02-28', 98.9, 2, 0.20718232044198895, 0.026464895580286862, 7.621768630198424, 7.522231099903556],
  ] as const)('%s%% %s @ %s (freq %s)', (coupon, maturity, price, frequency, ai, y, mac, mod) => {
    const r = bondAnalytics({ coupon, maturity, settlement: '2026-09-30', cleanPrice: price, frequency, dayCount: 'ACT/ACT ICMA' })!;
    expect(r.accruedPer100).toBeCloseTo(ai, 9);
    expect(r.yieldToMaturity!).toBeCloseTo(y, 8);
    expect(r.macaulayDuration!).toBeCloseTo(mac, 6);
    expect(r.modifiedDuration!).toBeCloseTo(mod, 6);
    expect(r.assumptions).toMatch(/ACT\/ACT ICMA/);
  });
  it('returns accrued only without a price, nothing for perpetuals or matured bonds', () => {
    const r = bondAnalytics({ coupon: 1, maturity: '2030-01-01', settlement: '2026-09-30', frequency: 1, dayCount: 'ACT/ACT ICMA' })!;
    expect(r.yieldToMaturity).toBeUndefined();
    expect(r.accruedPer100).toBeGreaterThan(0);
    expect(bondAnalytics({ coupon: 5, maturity: '9999-12-31', settlement: '2026-09-30', cleanPrice: 100, frequency: 1, dayCount: 'ACT/ACT ICMA' })).toBeUndefined();
    expect(bondAnalytics({ coupon: 5, maturity: '2025-01-01', settlement: '2026-09-30', cleanPrice: 100, frequency: 1, dayCount: 'ACT/ACT ICMA' })).toBeUndefined();
  });
  it('leaves yield empty when it is outside the solver range (distressed prices)', () => {
    const r = bondAnalytics({ coupon: 5, maturity: '2027-09-30', settlement: '2026-09-30', cleanPrice: 20, frequency: 1, dayCount: 'ACT/ACT ICMA' })!;
    expect(r.yieldToMaturity).toBeUndefined();
    expect(r.accruedPer100).toBe(0);
    const hi = bondAnalytics({ coupon: 5, maturity: '2027-09-30', settlement: '2026-09-30', cleanPrice: 70, frequency: 1, dayCount: 'ACT/ACT ICMA' })!;
    expect(hi.yieldToMaturity!).toBeCloseTo(105 / 70 - 1, 9);
  });
});
