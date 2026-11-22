import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVENTIONS, resolveHoldings, valueFromLegs } from './resolve.ts';
import type { Holding } from './holdings.ts';

const ctx = { ...DEFAULT_CONVENTIONS, valuationDate: '2026-09-30', portfolioCurrency: 'SEK', fx: { USD: { rate: 10.5, source: 'user' as const }, EUR: { rate: 11.5, source: 'user' as const } } };
const mk = (file: Holding['file'], index = 0): Holding => ({ index, row: index, file, unparsed: {} });
const one = (file: Holding['file']) => resolveHoldings([mk(file)], ctx).rows[0];
const values = (r: ReturnType<typeof one>) => [r.attrs.mv_local_dirty.value, r.attrs.mv_local_clean.value, r.attrs.mv_port_dirty.value, r.attrs.mv_port_clean.value];

describe('futures the file does not value', () => {
  it('are worth 0 after the daily variation margin, as the template says', () => {
    const r = one({ security_name: 'EURO STOXX 50 FUT DEC26', asset_type: 'Future', currency: 'EUR', quantity: 12, price: 4950, contract_size: 10 });
    expect(values(r)).toEqual([0, 0, 0, 0]);
    expect(r.attrs.mv_port_clean).toMatchObject({ source: 'derived', confidence: 'high' });
    expect(r.attrs.mv_port_clean.method).toMatch(/margined daily.*fields 22 and 24/);
  });
  it('keep the value the file gives', () => {
    const r = one({ security_name: 'EURO STOXX 50 FUT DEC26', asset_type: 'Future', currency: 'EUR', quantity: 12, price: 4950, market_value_local: 1200 });
    expect(r.attrs.mv_local_clean).toMatchObject({ value: 1200, source: 'file' });
  });
  it('options are not futures: their premium is their value, never guessed', () => {
    const r = one({ security_name: 'OMXS30 Call 2400 DEC26', asset_type: 'Option', currency: 'SEK', quantity: 10, price: 25 });
    expect(r.attrs.mv_local_clean.source).toBe('missing');
  });
});

describe('forwards and swaps from their legs', () => {
  const fwd = { security_name: 'FX FWD USD/SEK 15-DEC-2026', asset_type: 'FX forward', currency: 'USD', quantity: 1_000_000 };

  it('received leg − paid leg at the FX rates, an estimate marked low', () => {
    const r = one({ ...fwd, leg1_amount: 1_000_000, leg1_currency: 'USD', leg2_amount: 10_300_000, leg2_currency: 'SEK' });
    // 1,000,000 × 10.5 − 10,300,000 = 200,000 SEK; in USD ÷ 10.5.
    expect(values(r)).toEqual([19_047.62, 19_047.62, 200_000, 200_000]);
    expect(r.attrs.mv_port_clean).toMatchObject({ source: 'derived', confidence: 'low' });
    expect(r.attrs.mv_port_clean.method).toBe('Leg 1 received 1,000,000 USD × 10.5 − leg 2 paid 10,300,000 SEK × 1 = 200,000 SEK');
    expect(r.attrs.mv_port_clean.note).toMatch(/undiscounted, without forward points/);
  });

  it('a paid leg shown negative, and signs that make leg 2 the received one', () => {
    expect(one({ ...fwd, leg1_amount: 1_000_000, leg1_currency: 'USD', leg2_amount: -10_300_000, leg2_currency: 'SEK' }).attrs.mv_port_clean.value).toBe(200_000);
    const r = one({ ...fwd, leg1_amount: -10_300_000, leg1_currency: 'SEK', leg2_amount: 1_000_000, leg2_currency: 'USD' });
    expect(r.attrs.mv_port_clean.value).toBe(200_000);
    expect(r.attrs.mv_port_clean.method).toMatch(/^Leg 2 received 1,000,000 USD/);
  });

  it('one leg currency given: the other is the row currency when that differs', () => {
    const r = one({ ...fwd, leg1_amount: 1_000_000, leg2_amount: 10_300_000, leg2_currency: 'SEK' });
    expect(r.attrs.mv_port_clean.value).toBe(200_000);
    expect(r.attrs.mv_port_clean.method).toMatch(/leg 1 in the row's currency USD/);
  });

  it("a swap's legs in one currency: equal notionals are worth 0", () => {
    const r = one({ security_name: 'SEK 5Y PAYER IRS', asset_type: 'Interest rate swap', currency: 'SEK', quantity: 20_000_000, leg1_amount: 20_000_000, leg2_amount: -20_000_000 });
    expect(values(r)).toEqual([0, 0, 0, 0]);
    expect(r.attrs.mv_port_clean.confidence).toBe('low');
  });

  it('values nothing without both legs, both currencies of a forward, or an FX rate, and says why', () => {
    const onlyOne = one({ ...fwd, leg1_amount: 1_000_000, leg1_currency: 'USD' });
    expect(onlyOne.attrs.mv_port_clean.source).toBe('missing');
    expect(onlyOne.issues.join(' ')).toMatch(/needs both legs/);
    const noCcy = one({ ...fwd, leg1_amount: 1_000_000, leg2_amount: 10_300_000 });
    expect(noCcy.attrs.mv_port_clean.source).toBe('missing');
    expect(noCcy.issues.join(' ')).toMatch(/currency of a forward\/swap leg is not in the file/);
    const noRate = one({ ...fwd, leg1_amount: 1_000_000, leg1_currency: 'USD', leg2_amount: 800_000, leg2_currency: 'GBP' });
    expect(noRate.attrs.mv_port_clean.source).toBe('missing');
    expect(noRate.issues.join(' ')).toMatch(/No FX rate for GBP/);
  });

  it('the file value wins over the legs', () => {
    const r = one({ ...fwd, market_value_local: 12_345, leg1_amount: 1_000_000, leg1_currency: 'USD', leg2_amount: 10_300_000, leg2_currency: 'SEK' });
    expect(r.attrs.mv_local_clean).toMatchObject({ value: 12_345, source: 'file' });
  });

  it('valueFromLegs on its own', () => {
    const rate = (c: string) => ({ SEK: 1, EUR: 11.5 })[c];
    expect(valueFromLegs({ leg1_amount: 100, leg1_currency: 'EUR', leg2_amount: 1100, leg2_currency: 'SEK' }, 'EUR', false, rate, 'SEK').value).toBe(50);
    expect(valueFromLegs({}, 'EUR', false, rate)).toEqual({ method: '' });
  });
});
