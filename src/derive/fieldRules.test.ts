import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVENTIONS, resolveHoldings } from './resolve.ts';
import type { Holding } from './holdings.ts';
import { buildTptFiles } from '../export/buildTpt.ts';
import { emptyPortfolio, resolvePortfolioField } from '../portfolio/portfolio.ts';
import { spec } from '../spec/index.ts';

const ctx = { ...DEFAULT_CONVENTIONS, valuationDate: '2026-09-30', portfolioCurrency: 'SEK', fx: { USD: { rate: 10.5, source: 'user' as const }, EUR: { rate: 11.5, source: 'user' as const } } };
const mk = (file: Holding['file'], index = 0): Holding => ({ index, row: index, file, unparsed: {} });
const one = (file: Holding['file']) => resolveHoldings([mk(file)], ctx).rows[0];
const val = (r: ReturnType<typeof one>, k: keyof ReturnType<typeof one>['attrs']) => r.attrs[k].value;

describe('treasury bills: a discount instrument', () => {
  const bill = one({ security_name: 'SWEDISH T-BILL 17/03/2027', isin: 'SE0017830001', asset_type: 'Treasury bill', currency: 'SEK', nominal: 10_000_000, price: 98.9 });
  it('no coupon, nothing paid until maturity, repaid at par in one payment', () => {
    expect(String(bill.attrs.cic.value).slice(2)).toBe('15');
    expect([val(bill, 'coupon'), val(bill, 'coupon_frequency'), val(bill, 'redemption_type'), val(bill, 'redemption_rate'), val(bill, 'interest_rate_type')]).toEqual([0, '0', 'Bullet', 1, 'Fixed']);
    expect(bill.attrs.redemption_type).toMatchObject({ source: 'derived', confidence: 'high' });
  });
  it('yield and duration from price and maturity, and credit sensitivity equal to the duration', () => {
    const d = val(bill, 'modified_duration') as number;
    expect(d).toBeGreaterThan(0.4);
    expect(d).toBeLessThan(0.47);
    expect(val(bill, 'valuation_yield') as number).toBeCloseTo(2.4, 0);
    expect(val(bill, 'credit_sensitivity')).toBe(d);
  });
  it('a coupon in the file or the name is kept', () => {
    expect(val(one({ security_name: 'SWEDISH T-BILL 17/03/2027', asset_type: 'Treasury bill', currency: 'SEK', nominal: 1_000_000, price: 99, coupon: 1.5 }), 'coupon')).toBe(1.5);
  });
});

describe('bond terms read from what the file says', () => {
  it('a call date makes the bond callable (Cal) and stops credit sensitivity = duration', () => {
    const b = one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, coupon: 2.5, maturity_date: '2030-06-30', call_date: '2029-06-30', modified_duration: 2.7 });
    expect(val(b, 'callable')).toBe('Cal');
    expect(b.attrs.credit_sensitivity.source).toBe('missing');
  });
  it('a fixed-rate bond without a call: credit sensitivity = modified duration', () => {
    const b = one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, coupon: 2.5, maturity_date: '2030-06-30', modified_duration: 3.47 });
    expect(b.attrs.credit_sensitivity).toMatchObject({ value: 3.47, source: 'derived' });
    expect(b.attrs.callable.source).toBe('missing');
  });
  it('not for a floating-rate note', () => {
    const b = one({ security_name: 'SBAB FRN 2029', asset_type: 'Floating rate note', currency: 'SEK', nominal: 2_000_000, price: 100.3, modified_duration: 0.2 });
    expect(b.attrs.credit_sensitivity.source).toBe('missing');
  });
  it.each(['NR', 'Not rated', 'WR', 'n.r.'])('"%s" in the rating column is credit quality step 9 (no rating available)', (r) => {
    expect(val(one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, rating: r }), 'cqs')).toBe('9');
  });
  it('a rating is not turned into a credit quality step without the official mapping', () => {
    expect(one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, rating: 'BBB+' }).attrs.cqs.source).toBe('missing');
  });
});

describe('what the template asks to state when nothing was assessed', () => {
  const corp = one({ security_name: 'VOLVO 2.5% 30/06/2030', isin: 'XS1234567890', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98 });
  const covered = one({ security_name: 'STADSHYPOTEK 1.5% 01/03/2028', asset_type: 'Covered bond', currency: 'SEK', nominal: 1_000_000, price: 97 });
  const govt = one({ security_name: 'SWEDEN 0.75% 12/11/2029', isin: 'SE0011281922', asset_type: 'Government bond', currency: 'SEK', nominal: 1_000_000, price: 94 });
  const equity = one({ security_name: 'Volvo B', isin: 'SE0000115446', asset_type: 'Equity', currency: 'SEK', quantity: 100, price: 250 });
  it('infrastructure (132): not assessed, where the template asks for it', () => {
    expect([val(corp, 'infrastructure'), val(equity, 'infrastructure'), val(govt, 'infrastructure')]).toEqual(['0', '0', '0']);
  });
  it('collateral eligibility (138): 0 for covered bonds as the template says, not assessed for other corporate bonds, not asked for government bonds', () => {
    expect(covered.attrs.collateral_eligibility).toMatchObject({ value: '0', method: expect.stringMatching(/Covered bond/) });
    expect(val(corp, 'collateral_eligibility')).toBe('0');
    expect(govt.attrs.collateral_eligibility.source).toBe('missing');
  });
  it('bail-in (142): not assessed for corporate bonds; not asked for government bonds or equities', () => {
    expect(val(corp, 'bail_in')).toBe('0');
    expect([govt.attrs.bail_in.source, equity.attrs.bail_in.source]).toEqual(['missing', 'missing']);
  });
  it('counterparty sector (137): a bank account is code 12; a margin account and an ISIN instrument are left blank', () => {
    expect(val(one({ security_name: 'Cash SEK', asset_type: 'Cash', currency: 'SEK', market_value_local: 1_000_000 }), 'counterparty_sector')).toBe('12');
    const margin = one({ security_name: 'Initial margin account EUR', asset_type: 'Cash', currency: 'EUR', market_value_local: 50_000 });
    expect(margin.attrs.counterparty_sector.source).toBe('missing');
    expect(margin.attrs.counterparty_sector.note ?? margin.attrs.counterparty_sector.method ?? '').toMatch(/clearing house or broker/);
    expect(corp.attrs.counterparty_sector.source).toBe('missing');
  });
});

describe('delta 1 for linear derivatives where the template asks for a delta', () => {
  it('an FX forward and a commodity future; not an equity index future (no delta asked); never over the file', () => {
    expect(val(one({ security_name: 'FX FWD USD/SEK 15-DEC-2026', asset_type: 'FX forward', currency: 'USD', quantity: 1_000_000 }), 'delta')).toBe(1);
    expect(val(one({ security_name: 'BRENT CRUDE FUT DEC26', asset_type: 'Future', currency: 'USD', quantity: 5, price: 82 }), 'delta')).toBe(1);
    expect(one({ security_name: 'OMXS30 FUT DEC26', asset_type: 'Future', currency: 'SEK', quantity: 5, price: 2600 }).attrs.delta.source).toBe('missing');
    expect(val(one({ security_name: 'BRENT CRUDE FUT DEC26', asset_type: 'Future', currency: 'USD', quantity: 5, delta: 0.98 }), 'delta')).toBe(0.98);
  });
});

describe('exposure of futures and options (fields 27, 28, 30): the template formula', () => {
  const portfolio = emptyPortfolio();
  portfolio.values['4'] = 'SEK';
  portfolio.values['5'] = '100000000';
  portfolio.values['6'] = '2026-09-30';
  const col = (id: string) => spec.fields.findIndex((f) => f.id === id);
  const tpt = (file: Holding['file']) => {
    const result = resolveHoldings([mk(file)], { ...ctx, nav: 100_000_000 });
    return buildTptFiles(result, portfolio, ctx.fx, { today: '2026-10-05' })[0].rows[0];
  };
  it('an index future: quantity × contract size × index level', () => {
    const r = tpt({ security_name: 'EURO STOXX 50 FUT DEC26', asset_type: 'Future', currency: 'EUR', quantity: 79, contract_size: 10, underlying_price: 3145, price: 3150 });
    expect(r[col('27')]).toMatchObject({ value: 2_484_550, source: 'derived', confidence: 'high' });
    expect(r[col('28')].value).toBe(2_484_550 * 11.5);
    expect(r[col('30')].value).toBeCloseTo((2_484_550 * 11.5) / 100_000_000, 9);
  });
  it('options: × delta, and a put held long has a negative exposure', () => {
    const call = tpt({ security_name: 'OMXS30 Call 2400 DEC26', asset_type: 'Option', currency: 'SEK', quantity: 79, contract_size: 100, underlying_price: 2655, delta: 0.42 });
    expect(call[col('27')].value).toBeCloseTo(79 * 100 * 2655 * 0.42, 2);
    const put = tpt({ security_name: 'OMXS30 Put 2400 DEC26', asset_type: 'Option', currency: 'SEK', quantity: 79, contract_size: 100, underlying_price: 2655, delta: -0.31 });
    expect(put[col('27')].value).toBeCloseTo(-79 * 100 * 2655 * 0.31, 2);
    const shortPut = tpt({ security_name: 'OMXS30 Put 2400 DEC26', asset_type: 'Option', currency: 'SEK', quantity: -10, contract_size: 100, underlying_price: 2655, delta: 0.31 });
    expect(shortPut[col('27')].value).toBeCloseTo(10 * 100 * 2655 * 0.31, 2);
  });
  it('says what is missing, and leaves interest rate futures to the cheapest-to-deliver', () => {
    const r = tpt({ security_name: 'EURO STOXX 50 FUT DEC26', asset_type: 'Future', currency: 'EUR', quantity: 79, price: 3150 });
    expect(r[col('27')].source).toBe('missing');
    expect(r[col('27')].note).toMatch(/no contract size \(field 20\), underlying price \(field 72\)/);
    const bund = tpt({ security_name: 'EURO-BUND FUT DEC26', asset_type: 'Future', currency: 'EUR', quantity: 10, contract_size: 1000, underlying_price: 131 });
    expect(bund[col('27')].source).toBe('missing');
  });
});

describe('share price and number of shares (fields 8, 8b)', () => {
  it('each from the NAV and the other', () => {
    expect(resolvePortfolioField('8', { '5': '125000000', '8b': '1000000' }, undefined)).toMatchObject({ value: 125, source: 'derived' });
    expect(resolvePortfolioField('8b', { '5': '125000000', '8': '125' }, undefined)).toMatchObject({ value: 1_000_000, source: 'derived' });
    expect(resolvePortfolioField('8', { '5': '125000000', '8': '124.99' }, undefined)).toMatchObject({ value: '124.99', source: 'user' });
    expect(resolvePortfolioField('8', { '5': '125000000' }, undefined).source).toBe('missing');
  });
});

describe('commercial paper: usually a discount instrument (medium confidence)', () => {
  it('no coupon, bullet at par, flagged medium with why; a coupon in the file wins', () => {
    const cp = one({ security_name: 'NORDEA COMMERCIAL PAPER 15/01/2027', asset_type: 'Commercial paper', currency: 'SEK', nominal: 5_000_000, price: 99.2, maturity_date: '2027-01-15' });
    expect(String(cp.attrs.cic.value).slice(2)).toBe('23');
    expect([val(cp, 'coupon'), val(cp, 'coupon_frequency'), val(cp, 'redemption_type'), val(cp, 'redemption_rate')]).toEqual([0, '0', 'Bullet', 1]);
    expect(cp.attrs.coupon).toMatchObject({ confidence: 'medium', note: expect.stringMatching(/usually issued at a discount/) });
    expect(val(cp, 'modified_duration') as number).toBeGreaterThan(0.25);
    const interest = one({ security_name: 'NORDEA COMMERCIAL PAPER 15/01/2027', asset_type: 'Commercial paper', currency: 'SEK', nominal: 5_000_000, price: 100, coupon: 3.1 });
    expect(interest.attrs.coupon).toMatchObject({ value: 3.1, source: 'file' });
  });
});

describe('modified duration to the next call date (field 91)', () => {
  it('the bond maths to the call date, called at par: shorter than to maturity, marked an estimate', () => {
    const b = one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, coupon: 2.5, maturity_date: '2030-06-30', call_date: '2029-06-30', coupon_frequency: 1 });
    const toCall = val(b, 'duration_to_call') as number;
    const toMat = val(b, 'modified_duration') as number;
    expect(toCall).toBeGreaterThan(2.4);
    expect(toCall).toBeLessThan(toMat);
    expect(b.attrs.duration_to_call).toMatchObject({ source: 'derived', confidence: 'medium', note: expect.stringMatching(/called at par/) });
    expect(b.attrs.duration_to_call.method).toMatch(/call date 2029-06-30.*called at 100 on that date/);
  });
  it('nothing without a call date, or with a call date already past', () => {
    expect(one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, coupon: 2.5, maturity_date: '2030-06-30' }).attrs.duration_to_call.source).toBe('missing');
    expect(one({ security_name: 'VOLVO 2.5% 30/06/2030', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, coupon: 2.5, maturity_date: '2030-06-30', call_date: '2025-06-30' }).attrs.duration_to_call.source).toBe('missing');
  });
});
