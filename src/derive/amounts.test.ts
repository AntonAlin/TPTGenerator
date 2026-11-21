import { describe, expect, it } from 'vitest';
import { interpretAmounts, rankRow, type AmountContext } from './amounts.ts';
import type { AmountCell, AmountField, FileValues, Holding } from './holdings.ts';
import type { TotalRow } from '../ingest/table.ts';

/** Fixed table column per header, as in a real file. */
const COLS: Record<string, number> = { Holding: 0, Quantity: 0, Antal: 0, 'Market value': 1, MV: 1 };

/** Build a holding with amount cells; `cells` = [header, field, value]. */
function holding(index: number, file: FileValues, cells: [string, AmountField, number][]): Holding {
  const amountCells: AmountCell[] = cells.map(([header, field, value]) => ({ col: COLS[header] ?? 9, header, field, value }));
  const f: FileValues = { ...file };
  for (const c of amountCells) {
    if (c.field !== 'amount_mixed') (f as Record<string, unknown>)[c.field] = c.value;
  }
  return { index, row: index + 1, file: f, unparsed: {}, amountCells };
}

const roles = (r: ReturnType<typeof interpretAmounts>, i: number) => Object.fromEntries(r.interpretations[i]!.cells.map((c) => [c.cell.header, c.role]));
const ctx: AmountContext = { portfolioCurrency: 'SEK', fx: (c) => ({ SEK: 1, USD: 10, EUR: 11.5 })[c] };

describe('mixed "Holding" column with price and market value', () => {
  const hs = [
    holding(0, { security_name: 'Ericsson B', isin: 'SE0000108656', currency: 'SEK', price: 85.42 }, [['Holding', 'amount_mixed', 1000], ['Market value', 'market_value_local', 85420]]),
    holding(1, { security_name: 'SWEDEN 0.75% 12/11/2029', currency: 'SEK', price: 94.125 }, [['Holding', 'amount_mixed', 10_000_000], ['Market value', 'market_value_local', 9_412_500]]),
    holding(2, { security_name: 'Cash SEK', currency: 'SEK' }, [['Holding', 'amount_mixed', 3_010_000], ['Market value', 'market_value_local', 3_010_000]]),
    holding(3, { security_name: 'FX FWD EUR/USD 15-DEC-2026', currency: 'USD' }, [['Holding', 'amount_mixed', 5_000_000], ['Market value', 'market_value_local', 12_345.67]]),
    holding(4, { security_name: 'EURO STOXX 50 FUT DEC26', currency: 'EUR', price: 4950 }, [['Holding', 'amount_mixed', 10], ['Market value', 'market_value_local', 0]]),
  ];
  const r = interpretAmounts(hs, ctx);

  it('reads each cell by what the arithmetic and the row type say', () => {
    expect(roles(r, 0)).toEqual({ Holding: 'quantity', 'Market value': 'mv_local' });
    expect(roles(r, 1)).toEqual({ Holding: 'nominal', 'Market value': 'mv_local' });
    expect(roles(r, 2)).toEqual({ Holding: 'nominal', 'Market value': 'mv_local' });
    expect(roles(r, 3)).toEqual({ Holding: 'nominal', 'Market value': 'mv_local' });
    expect(roles(r, 4)).toEqual({ Holding: 'quantity', 'Market value': 'mv_local' });
  });
  it('sorts the values into the right fields', () => {
    expect(r.holdings[0].file).toMatchObject({ quantity: 1000, market_value_local: 85420 });
    expect(r.holdings[0].file.nominal).toBeUndefined();
    expect(r.holdings[1].file).toMatchObject({ nominal: 10_000_000, market_value_local: 9_412_500 });
    expect(r.holdings[1].file.quantity).toBeUndefined();
    expect(r.holdings[3].file).toMatchObject({ nominal: 5_000_000, market_value_local: 12_345.67 });
  });
  it('explains the decision and is confident where an identity holds', () => {
    expect(r.interpretations[0]!.evidence.join(' ')).toMatch(/× price = "Market value"/);
    expect(r.interpretations[1]!.evidence.join(' ')).toMatch(/× price ÷ 100 = "Market value"/);
    expect(r.interpretations[1]!.confidence).toBe('high');
    expect(r.interpretations[0]!.confidence).toBe('high');
  });
});

describe('bond nominal in a quantity column', () => {
  it('moves the cell to nominal when nominal × price ÷ 100 = value (also with accrued)', () => {
    const h = holding(0, { security_name: 'BUND 2.5% 15/02/2035', currency: 'EUR', price: 98.9, accrued_interest: 5000 }, [['Antal', 'quantity', 400_000], ['MV', 'market_value_local', 400_600]]);
    const r = interpretAmounts([h], ctx);
    expect(roles(r, 0)).toEqual({ Antal: 'nominal', MV: 'mv_local' });
    expect(r.interpretations[0]!.cells[0].moved).toBe(true);
    expect(r.interpretations[0]!.evidence.join(' ')).toMatch(/accrued/);
  });
  it('keeps the mapping when nothing contradicts it', () => {
    const h = holding(0, { security_name: 'Volvo B', currency: 'SEK', price: 271.8 }, [['Antal', 'quantity', 40_000], ['MV', 'market_value_local', 10_872_000]]);
    expect(roles(interpretAmounts([h], ctx), 0)).toEqual({ Antal: 'quantity', MV: 'mv_local' });
  });
});

describe('derivative notional shown in the market value column', () => {
  const rows = () => [
    holding(0, { security_name: 'SAP SE', currency: 'EUR', price: 245.1, weight: 0.5 }, [['Quantity', 'quantity', 4000], ['Market value', 'market_value_local', 980_400]]),
    holding(1, { security_name: 'Siemens AG', currency: 'EUR', price: 196.05, weight: 0.4999 }, [['Quantity', 'quantity', 5000], ['Market value', 'market_value_local', 980_250]]),
    holding(2, { security_name: 'FX FWD EUR/USD 15-DEC-2026', currency: 'EUR', weight: 0.0001 }, [['Market value', 'market_value_local', 5_000_000]]),
  ];
  const eur: AmountContext = { portfolioCurrency: 'EUR', fx: () => 1 };

  it('uses the reported column total', () => {
    const totals: TotalRow[] = [{ row: 9, label: 'Total', cells: [null, 1_960_650], subtotal: false }];
    const hs = rows().map((h) => ({ ...h, file: { ...h.file, weight: undefined } }));
    const r = interpretAmounts(hs, { ...eur, totals });
    expect(roles(r, 2)).toEqual({ 'Market value': 'nominal' });
    expect(r.holdings[2].file.market_value_local).toBeUndefined();
    expect(r.holdings[2].file.nominal).toBe(5_000_000);
    expect(r.interpretations[2]!.evidence[0]).toMatch(/adds up to the reported total/);
    expect(r.notes.join(' ')).toMatch(/matches after re-reading 1 cell/);
    expect(roles(r, 0)['Market value']).toBe('mv_local');
  });
  it('uses the weights when there is no total row', () => {
    const r = interpretAmounts(rows(), eur);
    expect(roles(r, 2)).toEqual({ 'Market value': 'nominal' });
  });
  it('uses the NAV when neither totals nor weights exist', () => {
    const hs = rows().map((h) => ({ ...h, file: { ...h.file, weight: undefined } }));
    const r = interpretAmounts(hs, { ...eur, nav: 2_000_000 });
    expect(roles(r, 2)).toEqual({ 'Market value': 'nominal' });
  });
  it('leaves a plausible derivative market value alone', () => {
    const hs = [rows()[0], rows()[1], holding(2, { security_name: 'FX FWD EUR/USD 15-DEC-2026', currency: 'EUR' }, [['Market value', 'market_value_local', 1234.5]])];
    const r = interpretAmounts(hs, { ...eur, nav: 2_000_000 });
    expect(roles(r, 2)).toEqual({ 'Market value': 'mv_local' });
  });
});

describe('notional duplicated in both market value columns', () => {
  it('drops both copies when the portfolio-currency total only adds up without them', () => {
    const COL = { Holding: 0, 'Market value': 1, 'Market value EUR': 2 };
    const mk = (index: number, file: FileValues, cells: [keyof typeof COL, AmountField, number][]): Holding => ({
      index,
      row: index + 1,
      file,
      unparsed: {},
      amountCells: cells.map(([header, field, value]) => ({ col: COL[header], header, field, value })),
    });
    const hs = [
      mk(0, { security_name: 'SAP SE', currency: 'EUR', price: 245.1 }, [['Holding', 'amount_mixed', 4000], ['Market value', 'market_value_local', 980_400], ['Market value EUR', 'market_value_portfolio', 980_400]]),
      mk(1, { security_name: 'MICROSOFT CORP', currency: 'USD', price: 425 }, [['Holding', 'amount_mixed', 2500], ['Market value', 'market_value_local', 1_062_500], ['Market value EUR', 'market_value_portfolio', 965_909.09]]),
      mk(2, { security_name: 'FX FWD EUR/USD 15-DEC-2026', currency: 'USD' }, [['Holding', 'amount_mixed', 2_000_000], ['Market value', 'market_value_local', 2_000_000], ['Market value EUR', 'market_value_portfolio', 1_818_181.82]]),
    ];
    const totals: TotalRow[] = [{ row: 9, label: 'Total', cells: [null, null, 1_946_309.09], subtotal: false }];
    const r = interpretAmounts(hs, { portfolioCurrency: 'EUR', fx: (c) => (c === 'USD' ? 1 / 1.1 : 1), totals });
    expect(roles(r, 2)).toEqual({ Holding: 'nominal', 'Market value': 'other', 'Market value EUR': 'other' });
    expect(r.holdings[2].file.nominal).toBe(2_000_000);
    expect(r.holdings[2].file.market_value_local).toBeUndefined();
    expect(r.holdings[2].file.market_value_portfolio).toBeUndefined();
    expect(roles(r, 1)).toEqual({ Holding: 'quantity', 'Market value': 'mv_local', 'Market value EUR': 'mv_port' });
  });
});

describe('"Nominal / market value" column with weights only', () => {
  it('estimates NAV from clear rows and reads equities as market values, bonds as nominal', () => {
    const hs = [
      holding(0, { security_name: 'Ericsson B', currency: 'SEK', price: 85.42, weight: 0.0855 }, [['Holding', 'amount_mixed', 855_000]]),
      holding(1, { security_name: 'Volvo B', currency: 'SEK', price: 271.8, weight: 0.1087 }, [['Holding', 'amount_mixed', 1_087_200]]),
      holding(2, { security_name: 'SWEDEN 0.75% 12/11/2029', currency: 'SEK', price: 94.125, weight: 0.4706 }, [['Holding', 'amount_mixed', 5_000_000]]),
      holding(3, { security_name: 'STADSHYPOTEK 1.5% 2028-03-01', currency: 'SEK', price: 98.2, weight: 0.2946 }, [['Holding', 'amount_mixed', 3_000_000]]),
      holding(4, { security_name: 'Likvida medel SEK', currency: 'SEK', weight: 0.0406 }, [['Holding', 'amount_mixed', 406_000]]),
    ];
    const r = interpretAmounts(hs, ctx);
    expect(r.navEstimate).toBeCloseTo(10_000_000, -4);
    expect(roles(r, 0)).toEqual({ Holding: 'mv_local' });
    expect(roles(r, 1)).toEqual({ Holding: 'mv_local' });
    expect(roles(r, 2)).toEqual({ Holding: 'nominal' });
    expect(roles(r, 3)).toEqual({ Holding: 'nominal' });
    expect(roles(r, 4)).toEqual({ Holding: 'mv_local' });
    expect(r.interpretations[0]!.evidence.join(' ')).toMatch(/÷ NAV = weight/);
  });
});

describe('ambiguity is reported, not hidden', () => {
  it('a mixed cell with nothing to check against gets low confidence and a runner-up', () => {
    const r = interpretAmounts([holding(0, { security_name: 'Ericsson B', currency: 'SEK' }, [['Holding', 'amount_mixed', 1000]])], ctx);
    expect(r.interpretations[0]!.confidence).toBe('low');
    expect(r.interpretations[0]!.runnerUp).toBeDefined();
    expect(r.interpretations[0]!.evidence[0]).toMatch(/No arithmetic check/);
  });
  it('ranks all assignments with probabilities summing to 1', () => {
    const ranked = rankRow([{ col: 0, header: 'A', field: 'amount_mixed', value: 1 }, { col: 1, header: 'B', field: 'amount_mixed', value: 2 }], { kind: 'unknown' });
    // 4 × 3 pairs of distinct value roles + 4 + 4 with one "other" + 1 with both "other".
    expect(ranked).toHaveLength(21);
    expect(ranked.reduce((a, r) => a + r.p, 0)).toBeCloseTo(1, 9);
  });
  it('rows without amount cells pass through unchanged', () => {
    const h: Holding = { index: 0, row: 1, file: { security_name: 'X' }, unparsed: {} };
    const r = interpretAmounts([h], ctx);
    expect(r.interpretations[0]).toBeUndefined();
    expect(r.holdings[0]).toBe(h);
  });
});
