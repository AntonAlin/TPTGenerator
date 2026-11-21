import { describe, expect, it } from 'vitest';
import { parseCouponText, parseSecurityName } from './parseName.ts';

describe('parseCouponText', () => {
  it.each([
    ['0.75', 0.75],
    ['3,5', 3.5],
    ['4 1/8', 4.125],
    ['1/2', 0.5],
    ['4⅛', 4.125],
    ['0', 0],
  ])('%s → %s', (t, v) => expect(parseCouponText(t)).toBeCloseTo(v));
  it('rejects junk', () => expect(parseCouponText('abc')).toBeUndefined());
});

describe('parseSecurityName', () => {
  it('SWEDEN 0.75% 12/11/2029 (day-first, ambiguous → low confidence)', () => {
    const p = parseSecurityName('SWEDEN 0.75% 12/11/2029');
    expect(p.coupon?.value).toBe(0.75);
    expect(p.coupon?.confidence).toBe('high');
    expect(p.maturity?.value).toBe('2029-11-12');
    expect(p.maturity?.confidence).toBe('low');
    expect(p.maturity?.note).toMatch(/2029-12-11/);
  });
  it('UST 4 1/8 15-NOV-32 (fractional coupon, month name)', () => {
    const p = parseSecurityName('UST 4 1/8 15-NOV-32');
    expect(p.coupon?.value).toBeCloseTo(4.125);
    expect(p.maturity).toMatchObject({ value: '2032-11-15', confidence: 'high' });
    expect(p.hints.has('government')).toBe(true);
  });
  it('BUND 0 02/15/31 (Bloomberg month-first)', () => {
    const p = parseSecurityName('BUND 0 02/15/31');
    expect(p.coupon?.value).toBe(0);
    expect(p.maturity?.value).toBe('2031-02-15');
    expect(p.hints.has('government')).toBe(true);
  });
  it('XYZ AB FRN 2027 (floating, year only)', () => {
    const p = parseSecurityName('XYZ AB FRN 2027');
    expect(p.hints.has('floating')).toBe(true);
    expect(p.maturity).toBeUndefined();
    expect(p.maturityYear).toBe(2027);
    expect(p.coupon).toBeUndefined();
  });
  it('decimal comma, ISO date, covered bond', () => {
    const p = parseSecurityName('Stadshypotek säkerställd 1,5% 2028-03-01');
    expect(p.coupon?.value).toBe(1.5);
    expect(p.maturity).toMatchObject({ value: '2028-03-01', confidence: 'high' });
    expect(p.hints.has('covered')).toBe(true);
  });
  it('German style name', () => {
    const p = parseSecurityName('Bundesrep. Deutschland 1,7% 15.08.2032');
    expect(p.coupon?.value).toBe(1.7);
    expect(p.maturity?.value).toBe('2032-08-15');
    expect(p.hints.has('government')).toBe(true);
  });
  it('perpetual subordinated', () => {
    const p = parseSecurityName('BANK X 5.25% PERP AT1');
    expect(p.maturity?.value).toBe('9999-12-31');
    expect(p.hints.has('subordinated')).toBe(true);
    expect(p.hints.has('perpetual')).toBe(true);
  });
  it('FRN margin is not trusted as coupon', () => {
    const p = parseSecurityName('NORDEA FRN STIBOR+0.85% 2027-05-12');
    expect(p.coupon?.confidence).toBe('low');
  });
  it.each([
    ['iShares Core MSCI World UCITS ETF', ['etf', 'fund', 'equity_fund']],
    ['Exempel Räntefond A', ['fund', 'debt_fund']],
    ['Likvida medel SEK', ['cash']],
    ['OMXS30 FUT DEC26', ['future']],
    ['EUR/SEK FWD 2026-12-15', ['forward']],
    ['Ericsson B', ['equity_class']],
    ['SAP SE Inhaber-Aktien', ['equity_class']],
    ['Volvo AB pref', ['preferred']],
    ['Swedbank Hypotek covered 1% 2030-06-15', ['covered']],
    ['Statsskuldväxel 2026-12-16', ['treasury_bill']],
    ['EIB 2.75% 15/09/2034', ['supranational']],
    ['Penningmarknadsfond Sverige', ['fund', 'money_market']],
  ])('%s hints', (name, hints) => {
    const p = parseSecurityName(name);
    for (const h of hints) expect([...p.hints]).toContain(h);
  });
  it('handles empty input', () => expect(parseSecurityName(undefined).hints.size).toBe(0));
});
