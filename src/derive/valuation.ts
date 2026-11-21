/**
 * Valuation and FX without market data:
 * - implied FX rates per currency from rows that have both local and portfolio values,
 * - a guess of the portfolio currency,
 * - an FX table the user completes once per currency,
 * - clean/dirty market value detection for bonds.
 *
 * FX rate convention throughout: 1 unit of the quotation currency = `rate` units of the portfolio currency.
 */
import { isTptCurrency } from '../data/iso.ts';
import type { Holding } from './holdings.ts';

export interface ImpliedFx {
  currency: string;
  rate: number;
  /** Number of rows the rate is based on. */
  rows: number;
  /** Largest relative deviation of a single row from the median. */
  maxDeviation: number;
  source: 'implied' | 'file-column';
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Implied FX per currency = market value in portfolio currency / market value in local currency. */
export function impliedFxRates(holdings: Holding[]): Record<string, ImpliedFx> {
  const byCcy = new Map<string, number[]>();
  const fromColumn = new Map<string, number[]>();
  for (const h of holdings) {
    const { currency: c, market_value_local: l, market_value_portfolio: p, fx_rate: fx } = h.file;
    if (!c) continue;
    if (l && p && Math.abs(l) > 1e-9) byCcy.set(c, [...(byCcy.get(c) ?? []), p / l]);
    if (fx && fx > 0) fromColumn.set(c, [...(fromColumn.get(c) ?? []), fx]);
  }
  const out: Record<string, ImpliedFx> = {};
  for (const [c, rs] of byCcy) {
    const rate = median(rs);
    out[c] = { currency: c, rate, rows: rs.length, maxDeviation: Math.max(...rs.map((r) => Math.abs(r / rate - 1))), source: 'implied' };
  }
  for (const [c, rs] of fromColumn) {
    if (out[c]) continue;
    const rate = median(rs);
    out[c] = { currency: c, rate, rows: rs.length, maxDeviation: Math.max(...rs.map((r) => Math.abs(r / rate - 1))), source: 'file-column' };
  }
  return out;
}

/**
 * Guess the portfolio currency: a currency code in the portfolio-value column header
 * ("Marknadsvärde SEK"), else the currency whose implied FX rate is 1.
 */
export function guessPortfolioCurrency(holdings: Holding[], portfolioValueHeader?: string): { currency?: string; why?: string } {
  const fromHeader = portfolioValueHeader?.match(/\b[A-Z]{3}\b/g)?.find((t) => isTptCurrency(t));
  if (fromHeader) return { currency: fromHeader, why: `Currency code in the column header "${portfolioValueHeader}"` };
  const implied = impliedFxRates(holdings);
  const one = Object.values(implied).filter((x) => x.source === 'implied' && Math.abs(x.rate - 1) < 1e-6 && x.rows >= 1);
  if (one.length === 1) return { currency: one[0].currency, why: `Local and portfolio values are equal for ${one[0].currency} holdings` };
  return {};
}

export interface FxEntry {
  rate: number;
  source: 'implied' | 'file-column' | 'user' | 'identity';
}

/**
 * Build the FX table for the valuation date: identity for the portfolio currency,
 * user entries override implied rates. Returns the table and the currencies still missing a rate.
 */
export function buildFxTable(
  currencies: string[],
  portfolioCurrency: string | undefined,
  implied: Record<string, ImpliedFx>,
  user: Record<string, number>,
): { table: Record<string, FxEntry>; missing: string[] } {
  const table: Record<string, FxEntry> = {};
  const missing: string[] = [];
  for (const c of [...new Set(currencies)].sort()) {
    if (c === portfolioCurrency) table[c] = { rate: 1, source: 'identity' };
    else if (user[c] > 0) table[c] = { rate: user[c], source: 'user' };
    else if (implied[c]) table[c] = { rate: implied[c].rate, source: implied[c].source };
    else missing.push(c);
  }
  return { table, missing };
}

export type MvConvention = 'auto' | 'clean' | 'dirty';

/**
 * Decide whether a bond's market value in the file is clean or dirty by
 * checking it against nominal × price / 100 (and that plus accrued interest).
 */
export function detectCleanDirty(mv: number, nominal: number, price: number, accrued: number): 'clean' | 'dirty' | undefined {
  const clean = (nominal * price) / 100;
  const tol = Math.max(1, Math.abs(clean) * 0.001);
  const isClean = Math.abs(mv - clean) <= tol;
  const isDirty = Math.abs(mv - (clean + accrued)) <= tol;
  if (isClean && !isDirty) return 'clean';
  if (isDirty && !isClean) return 'dirty';
  return undefined;
}
