import { describe, expect, it } from 'vitest';
import { detectTable } from './table.ts';
import { applySplit, datesFor, defaultChoice, detectSplit, needsChoice, withDefaultSplit } from './split.ts';

const H = ['Date', 'Portfolio', 'Name', 'ISIN', 'Quantity', 'Price'];
const rows = [
  H,
  ['2026-08-31', 'Fund A', 'Volvo B', 'SE0000115446', 100, 250],
  ['2026-08-31', 'Fund A', 'Ericsson B', 'SE0000108656', 200, 80],
  ['2026-08-31', 'Fund B', 'Volvo B', 'SE0000115446', 50, 250],
  ['2026-09-30', 'Fund A', 'Volvo B', 'SE0000115446', 110, 262],
  ['2026-09-30', 'Fund A', 'Ericsson B', 'SE0000108656', 210, 85],
  ['2026-09-30', 'Fund A', 'Cash SEK', '', 1000, 1],
  ['Total', '', '', '', '', ''],
];

describe('multi-portfolio / multi-date files', () => {
  const table = detectTable(rows);
  const split = detectSplit(table)!;

  it('finds the date and portfolio columns', () => {
    expect(split.dateCol).toBe(0);
    expect(split.portfolioCol).toBe(1);
    expect(split.dates).toEqual(['2026-08-31', '2026-09-30']);
    expect(split.portfolios).toEqual(['Fund A', 'Fund B']);
    expect(needsChoice(split)).toBe(true);
  });
  it('defaults to the first portfolio on its latest date', () => {
    expect(defaultChoice(split)).toEqual({ portfolio: 'Fund A', date: '2026-09-30' });
    expect(datesFor(split, 'Fund B')).toEqual(['2026-08-31']);
  });
  it('cuts the rows to the choice and drops the whole-file totals', () => {
    const cut = applySplit(table, split, { portfolio: 'Fund A', date: '2026-09-30' });
    expect(cut.rows.map((r) => r.cells[2])).toEqual(['Volvo B', 'Ericsson B', 'Cash SEK']);
    expect(cut.totals).toEqual([]);
    expect(cut.split?.choice).toEqual({ portfolio: 'Fund A', date: '2026-09-30' });
    expect(applySplit(table, split, { portfolio: 'Fund B', date: '2026-08-31' }).rows).toHaveLength(1);
  });
  it('reads Excel dates and Swedish headers', () => {
    const t = detectTable([
      ['Datum', 'Portfölj', 'Värdepapper', 'Antal'],
      [new Date(Date.UTC(2026, 8, 30)), 'Fond 1', 'Volvo B', 100],
      [new Date(Date.UTC(2026, 8, 30)), 'Fond 1', 'Ericsson B', 200],
      [new Date(Date.UTC(2026, 8, 30)), 'Fond 2', 'SEB A', 300],
      [new Date(Date.UTC(2026, 8, 30)), 'Fond 2', 'Investor B', 400],
    ]);
    const s = detectSplit(t)!;
    expect([s.dateCol, s.portfolioCol, s.dates, s.portfolios]).toEqual([0, 1, ['2026-09-30'], ['Fond 1', 'Fond 2']]);
  });
  it('leaves ordinary files alone', () => {
    // A maturity date is not an as-of date, and a "Fund" column listing the funds held is not a portfolio column.
    const t = detectTable([
      ['Fund', 'Maturity date', 'Quantity'],
      ['Nordic Equity A', '2030-01-15', 100],
      ['Global Bond I', '2031-06-30', 200],
      ['EM Debt B', '2029-03-01', 300],
    ]);
    expect(detectSplit(t)).toBeUndefined();
    expect(withDefaultSplit(t)).toBe(t);
  });
  it('a single portfolio on a single date needs no choice but still gives the date', () => {
    const t = withDefaultSplit(detectTable([H, ['2026-09-30', 'Fund A', 'Volvo B', 'SE0000115446', 100, 250], ['2026-09-30', 'Fund A', 'SEB A', 'SE0000148884', 10, 150]]));
    expect(needsChoice(t.split)).toBe(false);
    expect(t.split?.choice).toEqual({ portfolio: 'Fund A', date: '2026-09-30' });
    expect(t.rows).toHaveLength(2);
  });
});
