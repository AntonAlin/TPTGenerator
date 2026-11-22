import { describe, expect, it } from 'vitest';
import { agencyOf, callPutOf, exerciseOf, rateTypeOf, resolveHoldings, DEFAULT_CONVENTIONS } from './resolve.ts';
import { frequencyOf, type Holding } from './holdings.ts';
import { normalizeNace } from '../data/nace.ts';

describe('reading code-like fields as files write them', () => {
  it.each([
    ['Fixed', 'Fixed'], ['fast', 'Fixed'], ['Fest', 'Fixed'], ['fixe', 'Fixed'],
    ['Floating', 'Floating'], ['FRN', 'Floating'], ['Rörlig', 'Floating'], ['Variable', 'Variable'], ['inflation-linked', 'Inflation_linked'], ['banana', undefined],
  ])('interest rate type %s → %s', (v, want) => expect(rateTypeOf(v)).toBe(want));
  it.each([
    ['Call', 'Cal'], ['C', 'Cal'], ['köp', 'Cal'], ['Kaufoption', 'Cal'], ['PUT', 'Put'], ['p', 'Put'], ['Sälj', 'Put'], ['Floor', 'Flr'], ['x', undefined],
  ])('call/put %s → %s', (v, want) => expect(callPutOf(v)).toBe(want));
  it.each([['American', 'AM'], ['eu', 'EU'], ['Europeisk', 'EU'], ['europäisch', 'EU'], ['Bermudan', 'BE'], ['Asian', 'AS']])('exercise %s → %s', (v, want) => expect(exerciseOf(v)).toBe(want));
  it.each([["S&P", 'S&P'], ['Standard & Poors', 'S&P'], ["moody's", "Moody's"], ['Fitch Ratings', 'Fitch'], ['DBRS', 'DBRS']])('agency %s → %s', (v, want) => expect(agencyOf(v)).toBe(want));
  it.each([
    [1, 1], ['2', 2], ['Semi-annual', 2], ['halvår', 2], ['Quarterly', 4], ['trimestriel', 4], ['monthly', 12], ['årlig', 1], ['jährlich', 1], ['sometimes', undefined], [3, undefined],
  ])('coupon frequency %s → %s', (v, want) => expect(frequencyOf(v as string | number)).toBe(want));
  it.each([
    ['K64.1.9', 'K6419'], ['K6419', 'K6419'], ['64.19', 'K6419'], ['64.19Z', 'K6419'], ['C29.1', 'C291'], ['K', 'K'], ['29', 'C29'], ['Z99', undefined], ['banks', undefined],
  ])('NACE %s → %s', (v, want) => expect(normalizeNace(v)).toBe(want));
});

describe('the new fields reach the TPT, the file first', () => {
  const mk = (file: Holding['file'], index = 0): Holding => ({ index, row: index, file, unparsed: {} });
  const ctx = { ...DEFAULT_CONVENTIONS, valuationDate: '2026-09-30', portfolioCurrency: 'SEK', fx: {} };

  it('option terms', () => {
    const { rows } = resolveHoldings(
      [mk({ security_name: 'OMXS30 Put 2400 DEC26', asset_type: 'Option', currency: 'SEK', quantity: 100, contract_size: 100, strike: 2400, call_put: 'P', exercise_type: 'European', underlying_name: 'OMXS30', underlying_id: 'SE0000337842', underlying_price: 2655, delta: -0.31, market_value_local: 125_000 })],
      ctx,
    );
    const a = rows[0].attrs;
    expect([a.contract_size.value, a.strike.value, a.call_put.value, a.exercise_type.value, a.underlying_name.value, a.underlying_price.value, a.delta.value]).toEqual([100, 2400, 'Put', 'EU', 'OMXS30', 2655, -0.31]);
    expect([a.underlying_id.value, a.underlying_id_type.value]).toEqual(['SE0000337842', '1']);
    expect(a.call_put.source).toBe('file');
  });

  it('bond analytics and terms from the file win over computed ones; NACE and group are read, never guessed', () => {
    const { rows } = resolveHoldings(
      [
        mk({ security_name: 'VOLVO 2.5% 2030', isin: 'XS1234567890', asset_type: 'Corporate bond', currency: 'SEK', nominal: 1_000_000, price: 98, dirty_price: 99.2, coupon: 2.5, maturity_date: '2030-06-30', modified_duration: 3.47, yield: 3.05, coupon_frequency: 1, interest_rate_type: 'fast', call_date: '2029-06-30', cqs: 3, rating_agency: 'S&P', nace: '29.1', group_name: 'Volvo Group', group_lei: '549300HGV012CNC8JY22' }),
        mk({ security_name: 'SBAB FRN 2029', asset_type: 'Floating rate note', currency: 'SEK', nominal: 2_000_000, price: 100.3, spread: 0.9 }, 1),
      ],
      ctx,
    );
    const a = rows[0].attrs;
    expect([a.modified_duration.value, a.modified_duration.source, a.valuation_yield.value]).toEqual([3.47, 'file', 3.05]);
    expect([a.coupon_frequency.value, a.interest_rate_type.value, a.call_date.value, a.cqs.value, a.rating_agency.value]).toEqual(['1', 'Fixed', '2029-06-30', '3', 'S&P']);
    expect([a.nace.value, a.group_name.value]).toEqual(['C291', 'Volvo Group']);
    // Accrued from dirty − clean price.
    expect(a.accrued_local).toMatchObject({ value: 12_000, source: 'derived' });
    expect(rows[1].attrs.interest_margin.value).toBe(0.9);
  });
});
