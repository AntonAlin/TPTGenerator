import { describe, expect, it } from 'vitest';
import { economicZone, regionsAsOf } from './regions.ts';
import { countries, currencies, isCountry, isIsoCurrency, isTptCurrency, tptExtraCurrencies } from './iso.ts';
import { detectTable } from '../ingest/table.ts';
import { dateFromMetadata } from '../ui/session.ts';

describe('ISO lists', () => {
  it('contain the full ISO 3166-1 and ISO 4217 sets', () => {
    expect(countries).toHaveLength(249);
    expect(currencies.length).toBeGreaterThanOrEqual(170);
    expect(isCountry('se')).toBe(true);
    expect(isCountry('XA')).toBe(false);
    expect(isIsoCurrency('SEK')).toBe(true);
    expect(isIsoCurrency('CNH')).toBe(false);
  });
  it('accept the extra currency codes the TPT template allows', () => {
    expect(tptExtraCurrencies.map((c) => c.code)).toEqual(expect.arrayContaining(['CNH', 'GGP', 'JEP']));
    expect(isTptCurrency('CNH')).toBe(true);
    expect(isTptCurrency('XXQ')).toBe(false);
  });
});

describe('economic zones', () => {
  it.each([
    ['SE', 1],
    ['NO', 1],
    ['LI', 1],
    ['EU', 1],
    ['US', 2],
    ['CH', 2],
    ['GB', 2],
    ['CN', 3],
    ['BR', 3],
  ])('%s → %s', (c, z) => expect(economicZone(c)).toBe(z));
  it('is undefined for non-country codes', () => {
    expect(economicZone('XA')).toBeUndefined();
    expect(economicZone('XL')).toBeUndefined();
    expect(economicZone(undefined)).toBeUndefined();
  });
  it('records the as-of date of the membership lists', () => expect(regionsAsOf).toMatch(/^\d{4}-\d{2}$/));
});

describe('dateFromMetadata', () => {
  it('finds a valuation date in title rows above the table', () => {
    const t = detectTable([['Holdings report'], ['Per: 30/09/2026'], ['ISIN', 'Name', 'Value'], ['SE0000108656', 'A', 1], ['SE0000115446', 'B', 2]]);
    expect(dateFromMetadata(t)).toBe('2026-09-30');
    expect(dateFromMetadata(detectTable([['ISIN', 'Name'], ['SE0000108656', 'A'], ['SE0000115446', 'B']]))).toBeUndefined();
  });
});
