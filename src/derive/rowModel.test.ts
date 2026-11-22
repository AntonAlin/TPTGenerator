import { describe, expect, it } from 'vitest';
import { inferAssetClass } from './assetClass.ts';
import { predictRow, rowModel } from './rowModel.ts';
import { DEFAULT_CONVENTIONS, resolveHoldings, typeTextKey } from './resolve.ts';
import type { Holding } from './holdings.ts';
import { LearnedRepository } from '../profiles/learned.ts';
import { MemoryStore } from '../profiles/store.ts';

const V = '2026-09-30';

describe('the row model', () => {
  it('is calibrated and validated on held-out tables', () => {
    expect(rowModel.metrics.validationAccuracy as number).toBeGreaterThan(0.9);
    expect(rowModel.metrics.validationHighConfidenceAccuracy as number).toBeGreaterThan(0.98);
  });

  it.each([
    ['a put without the word "put": strike, contract size, negative delta', { security_name: 'OMXS30 2400 DEC26', quantity: 10, price: 25, contract_size: 100, strike: 2400, delta: -0.31, market_value_local: 25_000, maturity_date: '2026-12-18' }, 'put_option'],
    ['a call in trader shorthand', { security_name: 'ERIC B 70C DEC26', quantity: 50, price: 3.2, contract_size: 100, market_value_local: 16_000 }, 'call_option'],
    ['a future by its code', { security_name: 'FESX Z6', quantity: -4, price: 4850, contract_size: 10, market_value_local: 0, maturity_date: '2026-12-18' }, 'future'],
    ['a payer swap', { security_name: 'SEK 5Y PAYER IRS', quantity: 20_000_000, market_value_local: -184_000, maturity_date: '2031-09-30' }, 'swap'],
    ['a currency forward written as a pair and a date', { security_name: 'USD/SEK 2026-12-15', quantity: 1_500_000, market_value_local: 12_300, maturity_date: '2026-12-15' }, 'forward'],
    ['a fund with no fund keyword, priced per unit, Luxembourg ISIN', { security_name: 'Lannebo Sverige Plus', isin: 'LU0000000001', quantity: 1234.567, price: 41.2, market_value_local: 50_864.16 }, 'fund'],
    ['a government bond by its short code', { security_name: 'SGB 1061', isin: 'SE0000000001', nominal: 5_000_000, price: 98.7, market_value_local: 4_935_000, coupon: 0.75, maturity_date: '2032-11-12' }, 'gov_bond'],
  ] as const)('%s', (_, row, want) => {
    expect(predictRow(row, V).cls).toBe(want);
  });

  it('is unsure, and says so, when nothing tells call from put', () => {
    const p = predictRow({ security_name: 'OMXS30 2400 DEC26', quantity: 10, price: 25, contract_size: 100, strike: 2400, market_value_local: 25_000 }, V);
    expect(['call_option', 'put_option']).toContain(p.cls);
    expect(p.p).toBeLessThan(0.8);
  });
});

describe('rules first, the row model where they are unsure, lessons above both', () => {
  const put = { name: 'OMXS30 2400 DEC26', price: 25, valuationDate: V };
  const putRow = { security_name: 'OMXS30 2400 DEC26', quantity: 10, price: 25, contract_size: 100, strike: 2400, delta: -0.31, market_value_local: 25_000 };

  it('places a row the rules cannot, flagged for review', () => {
    const rules = inferAssetClass(put);
    expect(rules.assetClass).toBe('other');
    const r = inferAssetClass({ ...put, rowModel: predictRow(putRow, V) });
    expect(r.assetClass).toBe('put_option');
    expect(r.confidence).not.toBe('high');
    expect(r.evidence[0]).toMatch(/^Row model: \d+% put option \(from strike 2400/);
    expect(r.evidence[1]).toMatch(/no usable evidence; check it/);
  });

  it('leaves an asset-type text in the file in charge', () => {
    const r = inferAssetClass({ ...put, assetTypeText: 'Equity', rowModel: predictRow(putRow, V) });
    expect(r.assetClass).toBe('equity');
    expect(r.evidence.join(' ')).not.toMatch(/Row model/);
  });

  it('raises unsure rules when the model agrees', () => {
    const eq = { name: 'Volvo', isin: 'SE0000115446', price: 250, valuationDate: V };
    expect(inferAssetClass(eq).confidence).toBe('low');
    const r = inferAssetClass({ ...eq, rowModel: predictRow({ security_name: 'Volvo', isin: 'SE0000115446', quantity: 1000, price: 250, market_value_local: 250_000 }, V) });
    expect(r.assetClass).toBe('equity');
    expect(r.confidence).toBe('medium');
    expect(r.evidence.at(-1)).toMatch(/The row model agrees/);
  });

  it('a taught type code beats rules and model, and an ETF name does not make it a fund', () => {
    const r = inferAssetClass({ name: 'XACT OMXS30 ETF', assetTypeText: 'EQ-ETP', taughtType: { cls: 'equity', source: 'sep.xlsx' }, valuationDate: V });
    expect([r.assetClass, r.confidence, r.isEtf]).toEqual(['equity', 'high', false]);
    expect(r.evidence[0]).toBe('Asset type "EQ-ETP" is equity, as you taught (you set it in sep.xlsx)');
  });

  it('resolve applies type lessons to every row with that text', async () => {
    const repo = new LearnedRepository(new MemoryStore());
    await repo.teachType(' OPT-P ', 'put_option', 'oct.xlsx');
    const lessons = await repo.typeMap();
    expect(lessons.get(typeTextKey('opt p'))?.cls).toBe('put_option');
    const mk = (i: number): Holding => ({ index: i, row: i, unparsed: {}, file: { security_name: `OMX ${2300 + i * 50} DEC26`, asset_type: 'OPT-P', currency: 'SEK', quantity: 10, market_value_local: 1000 } });
    const { rows } = resolveHoldings([mk(0), mk(1)], { ...DEFAULT_CONVENTIONS, valuationDate: V, portfolioCurrency: 'SEK', fx: {}, typeLessons: lessons });
    expect(rows.map((r) => [r.effectiveClass, String(r.attrs.cic.value).slice(2, 3)])).toEqual([['put_option', 'C'], ['put_option', 'C']]);
    await repo.forgetType('opt-p');
    expect(await repo.types()).toEqual([]);
  });
});
