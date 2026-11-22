import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVENTIONS, resolveHoldings } from './resolve.ts';
import type { Holding } from './holdings.ts';
import { interpretAmounts } from './amounts.ts';
import { buildTptFiles } from '../export/buildTpt.ts';
import { emptyPortfolio } from '../portfolio/portfolio.ts';
import { spec } from '../spec/index.ts';
import { isBloombergTicker, listingFromBloomberg } from '../data/bloomberg.ts';

const ctx = { ...DEFAULT_CONVENTIONS, valuationDate: '2026-10-30', portfolioCurrency: 'EUR', fx: { USD: { rate: 0.861, source: 'user' as const }, CHF: { rate: 1.067, source: 'user' as const } } };
const mk = (file: Holding['file'], index = 0): Holding => ({ index, row: index, file, unparsed: {} });
const one = (file: Holding['file']) => resolveHoldings([mk(file)], ctx).rows[0];

describe('Bloomberg tickers', () => {
  it.each([
    ['ASML NA Equity', true, 'NL'], ['SPOT US Equity', true, 'US'], ['ERICB SS', true, 'SE'], ['SGE LN Equity', true, 'GB'], ['VGZ6 Index', true, undefined],
    ['ASML 12/18/26 C900 Equity', true, undefined], ['XYZ QQ Equity', true, undefined], ['Volvo B', false, undefined], ['SEC123456', false, undefined],
  ])('%s: ticker %s, listed in %s', (t, isTicker, country) => {
    expect(isBloombergTicker(t)).toBe(isTicker);
    expect(listingFromBloomberg(t)?.country).toBe(country);
  });

  it('the exchange code decides the CIC listing country, over a country-of-risk column', () => {
    const spot = one({ security_name: 'Spotify Technology SA', isin: 'LU1778762911', other_identifier: 'SPOT US Equity', asset_type: 'Equity', currency: 'USD', quantity: 9500, price: 612.3, country: 'SE' });
    expect(spot.attrs.cic).toMatchObject({ value: 'US31' });
    expect(spot.attrs.cic.note ?? '').not.toMatch(/country column/);
  });

  it('a row identified only by its ticker gets identification type 5', () => {
    const k = one({ security_name: 'Kontron AG', other_identifier: 'KTN AV Equity', asset_type: 'Equity', currency: 'EUR', quantity: 210_000, price: 21.36 });
    expect([k.attrs.identifier.value, k.attrs.id_type.value, k.attrs.cic.value]).toEqual(['KTN AV Equity', '5', 'AT31']);
    const fut = one({ security_name: 'EURO STOXX 50 Fut Dec26', other_identifier: 'VGZ6 Index', asset_type: 'Index Future', currency: 'EUR', quantity: -180, price: 5412 });
    expect([fut.attrs.identifier.value, fut.attrs.id_type.value]).toEqual(['VGZ6 Index', '5']);
  });
});

describe('CFDs and equity swaps', () => {
  const cfd = { security_name: 'CFD Short Temenos AG', isin: 'CH0012453913', other_identifier: 'TEMN SW Equity', asset_type: 'CFD', currency: 'CHF', quantity: -250_000, price: 68.4, market_value_local: 742_500 };

  it('a total return swap (D4), its value the P&L, its quantity shares, its ISIN and price the share\'s', () => {
    const r = one(cfd);
    expect(r.attrs.cic.value).toBe('XTD4');
    expect(r.attrs.cic.confidence).toBe('medium');
    expect(r.attrs.cic.note).toMatch(/no category for CFDs.*total return swap \(D4\)/);
    expect([r.attrs.quantity.value, r.attrs.nominal.source]).toEqual([-250_000, 'missing']);
    expect([r.attrs.identifier.source, r.attrs.underlying_id.value, r.attrs.underlying_id_type.value, r.attrs.underlying_name.value, r.attrs.underlying_price.value]).toEqual(['missing', 'CH0012453913', '1', 'Temenos AG', 68.4]);
    expect(r.attrs.mv_local_clean).toMatchObject({ value: 742_500, source: 'file' });
  });

  it('exposure is the equivalent position in the share: quantity × share price', () => {
    const p = emptyPortfolio();
    p.values['4'] = 'EUR';
    p.values['5'] = '250000000';
    p.values['6'] = '2026-10-30';
    const row = buildTptFiles(resolveHoldings([mk(cfd)], { ...ctx, nav: 250_000_000 }), p, ctx.fx, { today: '2026-11-22' })[0].rows[0];
    const col = (id: string) => spec.fields.findIndex((f) => f.id === id);
    expect(row[col('27')]).toMatchObject({ value: -17_100_000, source: 'derived' });
    expect(row[col('28')].value).toBeCloseTo(-17_100_000 * 1.067, 0);
  });

  it('"Contract for Difference" and "Total Return Swap" types and a TRS name are recognised the same way', () => {
    expect(one({ ...cfd, asset_type: 'Contract for Difference' }).attrs.cic.value).toBe('XTD4');
    expect(one({ ...cfd, security_name: 'TRS Short Soitec SA', asset_type: 'Equity Swap', currency: 'EUR' }).attrs.cic.value).toBe('XTD4');
  });

  it('the amount column holds shares, not a notional', () => {
    const h = mk({ security_name: 'CFD Long STMicroelectronics NV', isin: 'NL0000226223', asset_type: 'CFD', currency: 'EUR', price: 24.1 });
    h.amountCells = [
      { col: 0, header: 'Quantity', field: 'amount_mixed', value: 300_000 },
      { col: 1, header: 'Mkt Val (Local)', field: 'market_value_local', value: 412_800 },
    ];
    const r = interpretAmounts([h], { portfolioCurrency: 'EUR', fx: () => 1 });
    expect(r.holdings[0].file).toMatchObject({ quantity: 300_000, market_value_local: 412_800 });
    expect(r.holdings[0].file.nominal).toBeUndefined();
  });
});

describe('cash, margin and options', () => {
  it('a margin account is cash: the balance is the nominal, never a quantity', () => {
    const r = one({ security_name: 'Initial Margin - Morgan Stanley', asset_type: 'Margin', currency: 'EUR', quantity: 11_820_000, market_value_local: 11_820_000 });
    expect(r.attrs.cic.value).toBe('XT71');
    expect([r.attrs.quantity.source, r.attrs.nominal.value]).toEqual(['missing', 11_820_000]);
  });
  it('a plain "Option" takes call or put from the call/put column', () => {
    const r = one({ security_name: 'SX5E 18DEC26 P5100', asset_type: 'Index Option', call_put: 'Put', currency: 'EUR', quantity: 500, price: 48.9 });
    expect(String(r.attrs.cic.value).slice(2, 3)).toBe('C');
    expect(r.assetClass.confidence).toBe('high');
  });
});

describe('column headers of a hedge fund report', () => {
  it('exposure, country of risk and theme columns are not read as data; a Bloomberg ticker column is the identifier', async () => {
    const { classifyColumns } = await import('../detect/classify.ts');
    const n = 8;
    const cols = [
      { header: 'Security Description', values: ['ASML Holding NV', 'SAP SE', 'Infineon Technologies AG', 'Adyen NV', 'Prosus NV', 'Nokia Oyj', 'Capgemini SE', 'Nemetschek SE'] },
      { header: 'BBG Ticker', values: ['ASML NA Equity', 'SAP GY Equity', 'IFX GY Equity', 'ADYEN NA Equity', 'PRX NA Equity', 'NOKIA FH Equity', 'CAP FP Equity', 'NEM GY Equity'] },
      { header: 'ISIN', values: ['NL0010273215', 'DE0007164600', 'DE0006231004', 'NL0012969182', 'NL0013654783', 'FI0009000681', 'FR0000125338', 'DE0006452907'] },
      { header: 'Quantity', values: [28_000, 82_000, 410_000, 7_200, 190_000, 900_000, 52_000, 85_000] },
      { header: 'Price', values: [852.4, 238.15, 36.82, 1512, 52.18, 5.21, 152.3, 108.9] },
      { header: 'Mkt Val (EUR)', values: [23_867_200, 19_528_300, 15_096_200, 10_886_400, 9_914_200, 4_689_000, 7_919_600, 9_256_500] },
      { header: 'Delta Adj. Exposure EUR', values: [23_867_200, 19_528_300, 15_096_200, 10_886_400, 9_914_200, 4_689_000, 7_919_600, 9_256_500] },
      { header: 'Country of Risk', values: ['NL', 'DE', 'DE', 'NL', 'CN', 'FI', 'FR', 'DE'] },
      { header: 'Theme', values: Array.from({ length: n }, (_, i) => ['AI semis', 'Enterprise software', 'Payments'][i % 3]) },
    ];
    const m = Object.fromEntries(classifyColumns(cols).map((p) => [p.header, p.field]));
    expect(m).toMatchObject({ 'BBG Ticker': 'other_identifier', 'Delta Adj. Exposure EUR': 'ignore', 'Country of Risk': 'ignore', Theme: 'ignore', 'Mkt Val (EUR)': expect.stringMatching(/market_value/) });
  });
});
