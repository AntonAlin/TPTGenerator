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
  it('a share priced near 100 is equity when quantity × price = market value', () => {
    // Price 103.9 alone looks like a bond price (% of nominal); per-unit pricing says otherwise.
    expect(inferAssetClass({ name: 'Sandlux Holding', isin: 'DK8740020783', price: 103.9 }).assetClass).toBe('other');
    const r = inferAssetClass({ name: 'Sandlux Holding', isin: 'DK8740020783', price: 103.9, unitPriced: true });
    expect(r.assetClass).toBe('equity');
    expect(r.evidence.join(' ')).toMatch(/priced per unit/);
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
  it('picks derivative sub-categories from the underlying', () => {
    const cic = (name: string) => {
      const a = inferAssetClass({ name });
      return deriveCic({ assetClass: a.assetClass, assetClassConfidence: a.confidence, isEtf: false, derivativeSub: a.derivativeSub }).cic.value;
    };
    expect(cic('FX FWD EUR/USD 15-DEC-2026')).toBe('XTE2');
    expect(cic('Valutatermin SEK/NOK 2026-12-15')).toBe('XTE2');
    expect(cic('FRA 3X6 EURIBOR forward')).toBe('XTE1');
    expect(cic('IRS pay fixed 2.5% 2031 swap')).toBe('XTD1');
    expect(cic('TRS on index basket swap')).toBe('XTD4');
    expect(cic('CDS ITRAXX MAIN')).toBe('XTF1');
    expect(cic('Some forward contract')).toBe('XTE9');
    const fut = (name: string, isin = 'DE0000000001') => {
      const a = inferAssetClass({ name, isin });
      return deriveCic({ assetClass: a.assetClass, assetClassConfidence: a.confidence, isEtf: false, isin, derivativeSub: a.derivativeSub });
    };
    expect(fut('EURO STOXX 50 FUT DEC26').cic.value).toBe('DEA1');
    expect(fut('EURO BUND FUT DEC26').cic.value).toBe('DEA2');
    expect(fut('BRENT CRUDE OIL FUT DEC26').cic.value).toBe('DEA5');
    expect(fut('EURO STOXX 50 FUT DEC26').alternatives).toContain('DEA9');
    expect(fut('EURO STOXX 50 FUT DEC26').cic.note).toMatch(/from the underlying/);
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

describe('compound and French fund names', () => {
  it.each([
    ['Muster Rentenfonds I', 'fund_debt'],
    ['EXEMPLE MONETAIRE COURT TERME I', 'fund_money_market'],
    ['Penningmarknadsfond Sverige', 'fund_money_market'],
  ])('%s → %s', (name, cls) => expect(inferAssetClass({ name, isin: 'LU1234567896' }).assetClass).toBe(cls));

  it('reads instrument types as a portfolio system writes them', () => {
    const cls = (assetTypeText: string, name: string) => inferAssetClass({ assetTypeText, name });
    expect(cls('Option', 'OMXS30 Put 2400').assetClass).toBe('put_option');
    expect(cls('Option', 'Volvo B Call 270').assetClass).toBe('call_option');
    // The first of the two words decides: a USD put / SEK call is a put, on a currency.
    expect([cls('Option', 'USD put / SEK call 9.60').assetClass, cls('Option', 'USD put / SEK call 9.60').derivativeSub?.sub]).toEqual(['put_option', '3']);
    const neither = cls('Option', 'Some structured option');
    expect([neither.assetClass, neither.confidence]).toEqual(['call_option', 'low']);
    expect(cls('Credit default swap', 'iTraxx Crossover 5y').assetClass).toBe('credit_derivative');
    expect([cls('Interest rate swap', 'SEK 7y payer swap').assetClass, cls('Interest rate swap', 'SEK 7y payer swap').derivativeSub?.sub]).toEqual(['swap', '1']);
    expect([cls('FX forward / swap', 'Sell USD / buy SEK').assetClass, cls('FX forward / swap', 'Sell USD / buy SEK').derivativeSub?.sub]).toEqual(['forward', '2']);
    expect(cls('Money market / T-bill', 'Swedish T-bill').assetClass).toBe('treasury_bill');
    expect(cls('Money market / T-bill', 'Nordea commercial paper').assetClass).toBe('commercial_paper');
    expect(cls('Money market fund', 'Nordic Liquidity A').assetClass).toBe('fund_money_market');
    // "Treasury" in a corporate issuer's name does not override an explicit corporate type.
    expect(cls('Corporate bond', 'Volvo Treasury 3.625% 2029').assetClass).toBe('corporate_bond');
    expect(cls('Bond', 'US Treasury 4.125% 2031').assetClass).toBe('gov_bond');
  });
});
