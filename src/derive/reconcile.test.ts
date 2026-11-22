import { describe, expect, it } from 'vitest';
import { detectTable } from '../ingest/table.ts';
import type { RawCell } from '../ingest/readFile.ts';
import type { CanonicalField } from '../detect/canonical.ts';
import { normalizeHoldings } from './holdings.ts';
import { interpretAmounts } from './amounts.ts';
import { buildFxTable, impliedFxRates } from './valuation.ts';
import { DEFAULT_CONVENTIONS, resolveHoldings } from './resolve.ts';
import { navFromLines, reconcile } from './reconcile.ts';

const HEAD = ['ISIN', 'Name', 'Currency', 'Quantity', 'Price', 'Market value local', 'Market value SEK', 'Weight %'];
const MAP: CanonicalField[] = ['isin', 'security_name', 'currency', 'quantity', 'price', 'market_value_local', 'market_value_portfolio', 'weight'];
type Row = [string, string, string, number, number, number, number];

/** A custody report with sections, sub-totals, a total, a NAV line and weights of value ÷ NAV. */
function run(rows: { section: string; rows: Row[]; subtotalOffset?: number }[], opts: { nav?: number; navLine?: string; totalOffset?: number; userNav?: number; fxUser?: Record<string, number>; weightTotals?: boolean } = {}) {
  const nav = opts.nav ?? 1_200_000;
  const grid: RawCell[][] = [['Fund X: holdings 2026-09-30'], [opts.navLine ?? `Fondförmögenhet: ${nav.toLocaleString('sv-SE')} SEK`], [], HEAD];
  let total = 0;
  for (const s of rows) {
    grid.push([s.section]);
    let sub = 0;
    for (const r of s.rows) {
      grid.push([...r, Math.round((r[6] / nav) * 1e6) / 1e4]);
      sub += r[6];
    }
    grid.push([`Summa ${s.section.toLowerCase()}`, '', '', '', '', '', sub + (s.subtotalOffset ?? 0), opts.weightTotals ? Math.round((sub / nav) * 1e6) / 1e4 : '']);
    total += sub;
  }
  grid.push(['Totalt', '', '', '', '', '', total + (opts.totalOffset ?? 0), '']);
  const table = detectTable(grid);
  const norm = normalizeHoldings(table, MAP);
  const ccys = norm.holdings.map((h) => h.file.currency!).concat('SEK');
  const fx = buildFxTable(ccys, 'SEK', impliedFxRates(norm.holdings), opts.fxUser ?? {});
  const amounts = interpretAmounts(norm.holdings, { portfolioCurrency: 'SEK', fx: (c) => fx.table[c]?.rate, nav: opts.userNav, totals: norm.totals });
  const result = resolveHoldings(amounts.holdings, { ...DEFAULT_CONVENTIONS, valuationDate: '2026-09-30', portfolioCurrency: 'SEK', fx: fx.table, nav: opts.userNav });
  return reconcile({ table, mapping: MAP, holdings: amounts.holdings, totals: norm.totals, rows: result.rows, fx: fx.table, portfolioCurrency: 'SEK', nav: opts.userNav });
}

const EQ: Row[] = [
  ['SE0000108656', 'Ericsson B', 'SEK', 1000, 60, 60_000, 60_000],
  ['SE0000148884', 'SEB A', 'SEK', 2000, 150, 300_000, 300_000],
];
const BONDS: Row[] = [
  ['DE0001102580', 'BUND 0% 15/02/2032', 'EUR', 50_000, 90, 45_000, 517_500],
  ['FR0013508470', 'FRANCE OAT 0.75% 25/02/2028', 'EUR', 10_000, 96, 9_600, 110_400],
  ['US912828ZT04', 'UST 0.5% 31/05/2027', 'USD', 10_000, 95, 9_500, 99_750],
];

describe('reading a NAV written in the file', () => {
  it.each([
    ['Fondförmögenhet: 1 200 000 SEK', 1_200_000, 'SEK'],
    ['Net asset value (EUR): 98,765,432.10', 98_765_432.1, 'EUR'],
    ['Total net assets EUR 98.7m', 98_700_000, 'EUR'],
    ['NAV 12.5 MSEK', 12_500_000, undefined],
  ])('%s', (line, value, ccy) => {
    const n = navFromLines(['Some title', line]);
    expect(n?.value).toBeCloseTo(value, 2);
    if (ccy) expect(n?.currency).toBe(ccy);
  });
  it('ignores lines without a NAV keyword', () => expect(navFromLines(['Report date 2026-09-30', 'Page 1 of 3'])).toBeUndefined());
});

describe('reconciliation', () => {
  it('a clean report: every total, the NAV, weights, FX and rows agree', () => {
    const r = run([{ section: 'Aktier', rows: EQ }, { section: 'Obligationer', rows: BONDS }], { nav: 1_087_650 });
    const bad = r.checks.filter((c) => c.status === 'warn');
    expect(bad).toEqual([]);
    expect(r.flags).toEqual([]);
    expect(r.navFromFile?.value).toBe(1_087_650);
    const kinds = r.checks.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['subtotal', 'total', 'nav', 'weights', 'fx', 'rows']));
    expect(r.checks.filter((c) => c.kind === 'subtotal' && c.status === 'ok')).toHaveLength(2);
  });

  it('a sub-total that does not add up, a NAV the holdings fall short of, an FX outlier and a row off', () => {
    const bonds: Row[] = [...BONDS.slice(0, 2), ['DE0001102333', 'BUND 1% 15/08/2025', 'EUR', 10_000, 100, 10_000, 116_000]];
    const eq: Row[] = [['SE0000108656', 'Ericsson B', 'SEK', 1000, 61, 60_000, 60_000], EQ[1]];
    const r = run([{ section: 'Aktier', rows: eq }, { section: 'Obligationer', rows: bonds, subtotalOffset: 5000 }], { nav: 1_200_000, totalOffset: 5000 });
    const sub = r.checks.find((c) => c.kind === 'subtotal' && c.label.includes('obligationer'))!;
    expect(sub.status).toBe('warn');
    expect(sub.diff).toBeCloseTo(-5000);
    expect(r.checks.find((c) => c.kind === 'nav')!.status).toBe('warn');
    expect(r.checks.find((c) => c.kind === 'fx')!.status).toBe('warn');
    expect(r.flags.map((f) => [f.name, f.check])).toEqual(
      expect.arrayContaining([
        ['Ericsson B', 'rows'],
        ['BUND 1% 15/08/2025', 'fx'],
      ]),
    );
    expect(r.flags.find((f) => f.check === 'rows')!.message).toMatch(/Quantity × price = 61,000, but the market value is 60,000/);
  });

  it('a weight sub-total under 1.5% is read in percent like its column, not as a fraction', () => {
    // 0.17% of NAV: once read as 17% and reported as 0.17 apart.
    const tiny: Row[] = [['SE0000108656', 'Ericsson B', 'SEK', 10, 60, 600, 600], ['SE0000148884', 'SEB A', 'SEK', 10, 150, 1500, 1500]];
    const r = run([{ section: 'Aktier', rows: tiny }, { section: 'Obligationer', rows: BONDS }], { nav: 1_200_000, weightTotals: true });
    const w = r.checks.filter((c) => c.kind === 'subtotal' && c.label.includes('Weight'));
    expect(w.map((c) => c.status)).toEqual(['ok', 'ok']);
  });

  it('a user rate that differs from the file is pointed out', () => {
    const r = run([{ section: 'Obligationer', rows: BONDS.slice(0, 2) }], { nav: 627_900, fxUser: { EUR: 11.2 } });
    const fx = r.checks.find((c) => c.kind === 'fx')!;
    expect(fx.status).toBe('warn');
    expect(fx.detail).toMatch(/You entered 11.2000 \(-2.61% apart\)/);
  });
});
