import { describe, expect, it } from 'vitest';
import { findRelations } from './relations.ts';
import { classifyColumns, hungarian } from './classify.ts';
import type { ColumnInput } from './features.ts';

describe('relations between columns', () => {
  // qty × price = local value (units), nominal × price ÷ 100 for the bond; local × rate = SEK value.
  const qty = [100, 2000, 1_000_000, 50, 300];
  const price = [250, 85.5, 98.75, 1200, 42];
  const ccy = ['SEK', 'SEK', 'EUR', 'USD', 'SEK'];
  const rate: Record<string, number> = { SEK: 1, EUR: 11.5, USD: 10.5 };
  const local = qty.map((q, i) => (i === 2 ? (q * price[i]) / 100 : q * price[i]));
  const sek = local.map((l, i) => Math.round(l * rate[ccy[i]] * 100) / 100);
  const total = sek.reduce((a, b) => a + b, 0);
  const weight = sek.map((v) => Math.round((v / total) * 1e6) / 1e4);

  it('finds the product, the FX pair and the weight', () => {
    const r = findRelations([qty, price, local, sek, weight], ccy);
    expect(r.products).toContainEqual(expect.objectContaining({ a: 0, b: 1, c: 2, support: 1 }));
    expect(r.fx).toContainEqual(expect.objectContaining({ local: 2, port: 3 }));
    expect(r.weights).toContainEqual(expect.objectContaining({ value: 3, weight: 4 }));
  });

  it('maps meaningless headers from the relations alone', () => {
    const cols: ColumnInput[] = [
      { header: 'Col1', values: ['Volvo B', 'Ericsson B', 'BUND 2.5% 2035', 'Apple Inc', 'SEB A'] },
      { header: 'Col2', values: qty },
      { header: 'Col3', values: price },
      { header: 'Col4', values: ccy },
      { header: 'Col5', values: local },
      { header: 'Col6', values: sek },
    ];
    const m = classifyColumns(cols).map((p) => p.field);
    expect(m[4]).toBe('market_value_local');
    expect(m[5]).toBe('market_value_portfolio');
    expect(m[2]).toBe('price');
    expect(['quantity', 'amount_mixed', 'nominal']).toContain(m[1]);
    const reasons = classifyColumns(cols)[4].reasons.join(' ');
    expect(reasons).toMatch(/Col2" × "Col3"|one rate per currency/);
  });
});

describe('optimal assignment', () => {
  it('beats greedy claiming', () => {
    // Greedy would give row 0 column 0 (cost 1) and leave row 1 with column 1 (cost 10): total 11.
    // The optimum is row 0 → column 1 (2) and row 1 → column 0 (3): total 5.
    expect(hungarian([[1, 2], [3, 10]])).toEqual([1, 0]);
  });
  it('handles more columns than rows', () => {
    expect(hungarian([[5, 1, 9], [1, 9, 9]])).toEqual([1, 0]);
  });
});
