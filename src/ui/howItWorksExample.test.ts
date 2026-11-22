import { describe, expect, it } from 'vitest';
import { runExample } from './howItWorksExample.ts';

// The "How it works" page describes this example in words; these are the facts it relies on.
describe('the How it works example', () => {
  const e = runExample();
  const role = (name: string) => {
    const i = e.amounts.holdings.findIndex((h) => h.file.security_name === name);
    return Object.fromEntries(e.amounts.interpretations[i]!.cells.map((c) => [c.cell.header, c.role]));
  };
  it('finds the table and skips titles, section headings and the total', () => {
    expect(e.table.headers[0]).toBe('Värdepapper');
    expect(e.table.rows).toHaveLength(5);
    expect(e.table.skipped.map((s) => s.reason)).toEqual(['above-header', 'above-header', 'section-heading', 'section-heading', 'section-heading', 'section-heading', 'total']);
  });
  it('maps every column', () => {
    expect(e.predictions.map((p) => p.field)).toEqual(['security_name', 'isin', 'amount_mixed', 'price', 'currency', 'market_value_local', 'market_value_portfolio']);
    expect(e.base).toBe('SEK');
  });
  it('reads the holding column as shares, nominal or notional row by row', () => {
    expect(role('Ericsson B')['Antal/Nominellt']).toBe('quantity');
    expect(role('Microsoft Corp')['Antal/Nominellt']).toBe('quantity');
    expect(role('SWEDEN 0.75% 12/11/2029')['Antal/Nominellt']).toBe('nominal');
    expect(role('Likvida medel SEK')['Antal/Nominellt']).toBe('nominal');
  });
  it("drops the forward's notional from the value columns: the row repeats it and the total row agrees", () => {
    expect(role('FX FWD SEK/USD 15-DEC-2026')).toEqual({ 'Antal/Nominellt': 'nominal', 'Marknadsvärde lokal': 'other', 'Marknadsvärde SEK': 'other' });
    const i = e.amounts.holdings.findIndex((h) => h.file.security_name === 'FX FWD SEK/USD 15-DEC-2026');
    const it = e.amounts.interpretations[i]!;
    expect(it.evidence.join(' ')).toMatch(/repeats the notional/);
    expect(it.evidence[0]).toMatch(/adds up to the reported total .* without this figure/);
    expect(it.confidence).toBe('high');
    expect(e.amounts.notes.join(' ')).toMatch(/add up to the reported total 13,304,060 but for 12,400/);
  });
});
