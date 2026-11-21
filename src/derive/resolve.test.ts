import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { readWorkbook } from '../ingest/readFile.ts';
import { detectTable } from '../ingest/table.ts';
import { classifyColumns } from '../detect/classify.ts';
import { normalizeHoldings, type Holding } from './holdings.ts';
import { buildFxTable, guessPortfolioCurrency, impliedFxRates, detectCleanDirty } from './valuation.ts';
import { DEFAULT_CONVENTIONS, resolveHoldings, cicToAssetClass } from './resolve.ts';

function load(file: string) {
  const wb = readWorkbook(new Uint8Array(readFileSync(resolvePath(import.meta.dirname, '../../samples', file))), file);
  const t = detectTable(wb.sheets[0].rows);
  const mapping = classifyColumns(t.headers.map((h, i) => ({ header: h, values: t.rows.map((r) => r.cells[i]) }))).map((p) => p.field);
  return { t, ...normalizeHoldings(t, mapping) };
}

const mk = (file: Holding['file'], extra: Partial<Holding> = {}): Holding => ({ index: 0, row: 0, file, unparsed: {}, ...extra });

describe('normalizeHoldings', () => {
  it('parses the Swedish semicolon CSV with decimal commas and % weights', () => {
    const { holdings, notes, portfolioValueHeader } = load('se_fund_admin_semicolon.csv');
    expect(holdings[0].file).toMatchObject({ isin: 'SE0000108656', quantity: 12000, currency: 'SEK', market_value_portfolio: 1025040 });
    expect(holdings[0].file.weight).toBeCloseTo(0.0324, 6);
    expect(holdings[3].file.quantity).toBeCloseTo(1234.5678);
    expect(notes.join(' ')).toMatch(/percentages/);
    expect(portfolioValueHeader).toBe('Marknadsvärde SEK');
  });
  it('keeps xlsx dates and numbers', () => {
    const { holdings } = load('se_custodian_holdings.xlsx');
    const bond = holdings.find((h) => h.file.security_name?.startsWith('SWEDEN'))!;
    expect(bond.file).toMatchObject({ maturity_date: '2029-11-12', price: 94.125, quantity: 10000000 });
    expect(bond.section).toBe('Obligationer');
  });
});

describe('valuation helpers', () => {
  it('implies FX rates and guesses the portfolio currency', () => {
    const { holdings, portfolioValueHeader } = load('se_custodian_holdings.xlsx');
    const fx = impliedFxRates(holdings);
    expect(fx.USD.rate).toBeCloseTo(10.4, 6);
    expect(fx.EUR.rate).toBeCloseTo(11.5, 6);
    expect(fx.SEK.rate).toBe(1);
    expect(guessPortfolioCurrency(holdings, portfolioValueHeader).currency).toBe('SEK');
    const { table, missing } = buildFxTable(['SEK', 'USD', 'EUR', 'NOK'], 'SEK', fx, { EUR: 11.6 });
    expect(table.EUR).toEqual({ rate: 11.6, source: 'user' });
    expect(table.SEK.source).toBe('identity');
    expect(missing).toEqual(['NOK']);
  });
  it('detects clean vs dirty values', () => {
    expect(detectCleanDirty(9412500, 10000000, 94.125, 66164)).toBe('clean');
    expect(detectCleanDirty(9478664, 10000000, 94.125, 66164)).toBe('dirty');
    expect(detectCleanDirty(5, 10000000, 94.125, 66164)).toBeUndefined();
  });
  it('maps CIC back to asset classes', () => {
    expect(cicToAssetClass('SE11')).toBe('gov_bond');
    expect(cicToAssetClass('XL46')).toBe('fund_alternative');
    expect(cicToAssetClass('SE39')).toBe('equity');
  });
});

describe('resolveHoldings', () => {
  const ctxBase = { ...DEFAULT_CONVENTIONS, valuationDate: '2026-09-30', portfolioCurrency: 'SEK' };

  it('resolves the Swedish custodian sample end to end', () => {
    const { holdings } = load('se_custodian_holdings.xlsx');
    const fx = buildFxTable(holdings.map((h) => h.file.currency!), 'SEK', impliedFxRates(holdings), {}).table;
    const { rows, portfolio } = resolveHoldings(holdings, { ...ctxBase, fx });
    const eric = rows[0];
    expect(eric.attrs.cic).toMatchObject({ value: 'SE31', source: 'derived' });
    expect(eric.attrs.mv_local_dirty).toMatchObject({ value: 10250400, source: 'file' });
    expect(eric.attrs.mv_local_clean.value).toBe(10250400);
    expect(eric.attrs.accrued_local).toMatchObject({ value: 0, source: 'derived', confidence: 'high' });
    expect(eric.attrs.issuer_country).toMatchObject({ value: 'SE', source: 'derived', confidence: 'low' });
    expect(eric.attrs.weight).toMatchObject({ source: 'file' });
    expect(eric.attrs.weight.value).toBeCloseTo(0.204, 6);
    expect(eric.attrs.underlying_category.value).toBe('3L');

    const sgb = rows.find((r) => r.holding.file.security_name === 'SWEDEN 0.75% 12/11/2029')!;
    expect(sgb.effectiveClass).toBe('gov_bond');
    expect(sgb.attrs.cic.value).toBe('SE11');
    expect(sgb.attrs.maturity).toMatchObject({ value: '2029-11-12', source: 'file' });
    expect(sgb.attrs.coupon).toMatchObject({ value: 0.75, source: 'derived' });
    expect(sgb.attrs.interest_rate_type.value).toBe('Fixed');
    expect(sgb.attrs.nominal).toMatchObject({ value: 10000000, source: 'derived' });
    // File value 9 412 500 = nominal × price → clean; dirty adds the computed accrued interest.
    expect(sgb.attrs.mv_local_clean).toMatchObject({ value: 9412500, source: 'file' });
    expect(sgb.attrs.accrued_local.value).toBeCloseTo(66164.38, 1);
    expect(sgb.attrs.mv_local_dirty.value).toBeCloseTo(9478664.38, 1);
    expect(sgb.attrs.modified_duration.value).toBeCloseTo(2.989371, 5);
    expect(sgb.attrs.valuation_yield.value).toBeCloseTo(2.7413483, 5);
    expect(sgb.attrs.issuer_country).toMatchObject({ value: 'SE', confidence: 'medium' });

    const frn = rows.find((r) => r.holding.file.security_name?.includes('FRN'))!;
    expect(frn.attrs.interest_rate_type.value).toBe('Floating');
    expect(frn.attrs.modified_duration.source).toBe('missing');
    expect(frn.attrs.accrued_local.source).toBe('missing');
    expect(frn.attrs.mv_local_dirty).toMatchObject({ value: 5017500, confidence: 'low' });

    const cash = rows.find((r) => r.holding.file.security_name === 'Likvida medel SEK')!;
    expect(cash.attrs.cic.value).toBe('XT71');
    expect(cash.attrs.issuer_country.source).toBe('missing');

    expect(portfolio.nav.source).toBe('derived');
    expect(portfolio.cashRatio.value).toBeCloseTo(0.0599, 6);
    expect(portfolio.modifiedDuration.value).toBeGreaterThan(0);
  });

  it('derives values from FX and quantity × price, and weights from an entered NAV', () => {
    const hs = [
      mk({ isin: 'US0378331005', security_name: 'Apple Inc', currency: 'USD', quantity: 10, price: 200 }),
      mk({ security_name: 'Cash USD', currency: 'USD', market_value_local: 1000 }, { index: 1 }),
    ];
    const { rows, portfolio } = resolveHoldings(hs, { ...ctxBase, fx: { USD: { rate: 10, source: 'user' } }, nav: 50000 });
    expect(rows[0].attrs.mv_local_clean).toMatchObject({ value: 2000, source: 'derived' });
    expect(rows[0].attrs.mv_port_dirty).toMatchObject({ value: 20000, source: 'derived' });
    expect(rows[0].attrs.weight).toMatchObject({ value: 0.4, source: 'derived' });
    expect(rows[1].attrs.cic.value).toBe('XT71');
    expect(portfolio.nav).toMatchObject({ value: 50000, source: 'user' });
    expect(portfolio.cashRatio.value).toBeCloseTo(0.2);
  });

  it('reports a missing FX rate and invalid identifiers', () => {
    const { rows } = resolveHoldings([mk({ isin: 'US0378331006', security_name: 'X', currency: 'NOK', market_value_local: 5 })], { ...ctxBase, fx: {} });
    expect(rows[0].attrs.mv_port_dirty.source).toBe('missing');
    expect(rows[0].attrs.mv_port_dirty.note).toMatch(/NOK/);
    expect(rows[0].issues[0]).toMatch(/not a valid ISIN/);
  });

  it('a cash balance is its market value; a derivative gets no quantity × price value', () => {
    const hs = [
      mk({ security_name: 'Custody account NOK', asset_type: 'Cash / deposit', currency: 'NOK', nominal: 4_500_000 }),
      mk({ security_name: 'OMXS30 Index Future', asset_type: 'Future', currency: 'SEK', quantity: -120, price: 2655 }, { index: 1 }),
      mk({ security_name: 'Volvo B Call 270', asset_type: 'Option', currency: 'SEK', quantity: 400, price: 4.2 }, { index: 2 }),
    ];
    const { rows } = resolveHoldings(hs, { ...ctxBase, fx: { NOK: { rate: 0.9, source: 'user' } } });
    expect(rows[0].attrs.mv_local_clean).toMatchObject({ value: 4_500_000, source: 'derived', confidence: 'high' });
    expect(rows[0].attrs.mv_port_clean.value).toBe(4_050_000);
    expect(rows[1].attrs.cic.value).toBe('XLA1');
    expect(rows[1].attrs.mv_local_clean.source).toBe('missing');
    expect(rows[2].attrs.mv_local_clean.source).toBe('missing');
  });
});
