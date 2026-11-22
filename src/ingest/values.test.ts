import { describe, expect, it } from 'vitest';
import { detectDateOrder, detectDecimalSeparator, excelSerialToIso, parseDate, parseNumber } from './values.ts';

const n = (s: unknown, d?: ',' | '.') => parseNumber(s, d)?.value;

describe('parseNumber', () => {
  it.each(['FWD-5472', 'SEC123456', 'OPT 120', 'XYZ 1 000'])('an identifier with letters is not a number: %s', (v) => expect(parseNumber(v)).toBeUndefined());
  it.each([['SEK 1 000', 1000], ['EUR -12.5', -12.5], ['12 USD', 12], ['1,000 €', 1000]])('a real currency code or symbol is stripped: %s', (v, want) =>
    expect(parseNumber(v)?.value).toBe(want),
  );
  it.each([
    ['1234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1 234 567,89', 1234567.89],
    ['1 234,5', 1234.5],
    ["1'234.50", 1234.5],
    ['0,75', 0.75],
    ['-12,5', -12.5],
    ['(1,000.00)', -1000],
    ['1234.50-', -1234.5],
    ['SEK 1 000', 1000],
    ['1,000 €', 1000],
    ['1.5e3', 1500],
    ['−3', -3],
  ])('%s → %s', (s, v) => expect(n(s)).toBeCloseTo(v as number, 10));

  it('reads a single comma with 3 decimals as thousands unless told otherwise', () => {
    expect(n('1,234')).toBe(1234);
    expect(n('1,234', ',')).toBeCloseTo(1.234);
  });
  it('flags percentages without scaling', () => expect(parseNumber('4,5 %')).toEqual({ value: 4.5, percent: true }));
  it.each(['abc', '', '12/03/2025', 'SE0000108656', '1.2.3,4,5', '12,34,5'])('rejects %s', (s) => expect(n(s)).toBeUndefined());
  it('passes numbers through', () => expect(n(3.5)).toBe(3.5));
});

describe('detectDecimalSeparator', () => {
  it('detects comma columns', () => expect(detectDecimalSeparator(['1 234,50', '0,75', '12'])).toBe(','));
  it('detects point columns', () => expect(detectDecimalSeparator(['1,234.50', '0.75'])).toBe('.'));
  it('reads 1.234.567 as comma-decimal', () => expect(detectDecimalSeparator(['1.234.567'])).toBe(','));
  it('no evidence', () => expect(detectDecimalSeparator(['12', '1,234'])).toBeUndefined());
});

describe('parseDate', () => {
  it.each([
    ['2029-11-12', '2029-11-12'],
    ['2029/11/12', '2029-11-12'],
    ['20291112', '2029-11-12'],
    ['12/11/2029', '2029-11-12'],
    ['12.11.29', '2029-11-12'],
    ['31/03/2025', '2025-03-31'],
    ['03/31/2025', '2025-03-31'],
    ['15-NOV-32', '2032-11-15'],
    ['15 Nov 2032', '2032-11-15'],
    ['Nov 15, 2032', '2032-11-15'],
    ['15 maj 2030', '2030-05-15'],
    ['1. Dez 2030', '2030-12-01'],
    ['2025-03-31T00:00:00', '2025-03-31'],
  ])('%s → %s', (s, iso) => expect(parseDate(s)).toBe(iso));
  it('honours month-first order for ambiguous dates', () => expect(parseDate('03/04/2025', 'MDY')).toBe('2025-03-04'));
  it.each(['2025-02-30', '13/13/2025', 'hello', '12', ''])('rejects %s', (s) => expect(parseDate(s)).toBeUndefined());
  it('detects date order', () => {
    expect(detectDateOrder(['31/01/2025', '01/02/2025'])).toBe('DMY');
    expect(detectDateOrder(['01/31/2025'])).toBe('MDY');
  });
  it('converts Excel serials', () => {
    expect(excelSerialToIso(45747)).toBe('2025-03-31');
    expect(excelSerialToIso(12)).toBeUndefined();
  });
});
