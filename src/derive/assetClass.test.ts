import { describe, expect, it } from 'vitest';
import { inferAssetClass } from './assetClass.ts';
import { deriveCic, quotationZoneFromCic, underlyingCategoryFromCic } from './cicDerive.ts';

describe('inferAssetClass', () => {
  it.each([
    [{ name: 'Ericsson B', isin: 'SE0000108656', price: 85.42 }, 'equity'],
    [{ name: 'SWEDEN 0.75% 12/11/2029', isin: 'SE0000000001' }, 'gov_bond'],
    [{ name: 'EXEMPEL BANK AB FRN 2027' }, 'corporate_bond'],
    [{ name: 'Stadshypotek säkerställd 1,5% 2028-03-01' }, 'covered_bond'],
    [{ name: 'iShares Core MSCI World UCITS ETF' }, 'fund_equity'],
    [{ name: 'Exempel Räntefond A' }, 'fund_debt'],
    [{ name: 'Likvida medel SEK' }, 'cash'],
    [{ name: 'OMXS30 FUT DEC26' }, 'future'],
    [{ name: 'EUR/SEK FWD 2026-12-15' }, 'forward'],
    [{ name: 'Statsskuldväxel 2026-12-16' }, 'treasury_bill'],
    [{ name: 'EIB 2.75% 15/09/2034' }, 'supranational_bond'],
    [{ name: 'BANK X 5.25% PERP AT1' }, 'subordinated_bond'],
    [{ name: 'Something', assetTypeText: 'Aktier' }, 'equity'],
    [{ name: 'Muster Rentenfonds I', assetTypeText: 'Fonds' }, 'fund_debt'],
    [{ name: 'Holding X', section: 'Obligationer', hasCoupon: true, hasMaturity: true }, 'corporate_bond'],
    [{ name: 'Kingdom of Sweden', section: 'Obligationer' }, 'gov_bond'],
    [{ name: 'Mystery', isin: 'XS1234567890' }, 'corporate_bond'],
    [{ name: '???' }, 'other'],
  ])('%o → %s', (input, cls) => expect(inferAssetClass(input).assetClass).toBe(cls));

  it('records evidence and confidence', () => {
    const r = inferAssetClass({ name: 'Foo', assetTypeText: 'Equity' });
    expect(r.confidence).toBe('high');
    expect(r.evidence[0]).toMatch(/Asset type "Equity"/);
    expect(inferAssetClass({ name: '???' }).confidence).toBe('low');
  });
  it('splits deposits by term', () => {
    expect(inferAssetClass({ name: 'Term deposit', maturity: '2028-01-01', valuationDate: '2026-09-30' }).assetClass).toBe('deposit_long');
  });
});

describe('deriveCic', () => {
  it('uses the file country as listing country (estimated)', () => {
    const r = deriveCic({ assetClass: 'equity', assetClassConfidence: 'high', isEtf: false, isin: 'US0378331005', fileCountry: 'SE' });
    expect(r.cic.value).toBe('SE31');
    expect(r.cic.confidence).toBe('low');
    expect(r.cic.note).toMatch(/estimated/);
  });
  it('falls back to the ISIN prefix', () => {
    expect(deriveCic({ assetClass: 'equity', assetClassConfidence: 'high', isEtf: false, isin: 'US0378331005' }).cic.value).toBe('US31');
  });
  it('XS ISIN → XL proposed with a note', () => {
    const r = deriveCic({ assetClass: 'corporate_bond', assetClassConfidence: 'medium', isEtf: false, isin: 'XS1234567890' });
    expect(r.cic.value).toBe('XL21');
    expect(r.cic.note).toMatch(/not a country/);
    expect(r.alternatives).toEqual(['XL28', 'XL25', 'XL29']);
  });
  it('cash and OTC derivatives are XT; non-ETF funds XL; ETFs use the listing country', () => {
    expect(deriveCic({ assetClass: 'cash', assetClassConfidence: 'high', isEtf: false }).cic.value).toBe('XT71');
    expect(deriveCic({ assetClass: 'forward', assetClassConfidence: 'high', isEtf: false }).cic.value).toBe('XTE9');
    expect(deriveCic({ assetClass: 'fund_debt', assetClassConfidence: 'high', isEtf: false, isin: 'SE0001234567' }).cic.value).toBe('XL42');
    expect(deriveCic({ assetClass: 'fund_equity', assetClassConfidence: 'high', isEtf: true, isin: 'IE00B4L5Y983' }).cic.value).toBe('IE41');
  });
  it('maps CIC to fields 13 and 131', () => {
    expect(quotationZoneFromCic('SE31')?.value).toBe(1);
    expect(quotationZoneFromCic('US31')?.value).toBe(2);
    expect(quotationZoneFromCic('BR31')?.value).toBe(3);
    expect(quotationZoneFromCic('XL42')?.value).toBe(0);
    expect(underlyingCategoryFromCic('SE31')?.value).toBe('3L');
    expect(underlyingCategoryFromCic('XL31')?.value).toBe('3X');
    expect(underlyingCategoryFromCic('XT71')?.value).toBe('7');
    expect(underlyingCategoryFromCic('DEA1')?.value).toBe('A');
  });
});
