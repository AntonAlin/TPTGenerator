/**
 * Files that hold several portfolios and/or several dates in one table: a Date column ("Date",
 * "Datum", "As of", "Stichtag", …) and a Portfolio column ("Portfolio", "Fund", "Konto", "Depå", …),
 * as fund administrators and portfolio systems export them. A TPT is for one portfolio on one
 * valuation date, so the rows are cut down to one (portfolio, date) pair, chosen by the user.
 *
 * Detection is deliberately strict: the header must be one of the known names (a maturity or trade
 * date column must never be taken for the as-of date) and the values must look the part (dates in
 * the date column, a few names repeated in the portfolio column).
 */
import type { DataRow, DetectedTable } from './table.ts';
import { excelSerialToIso, parseDate } from './values.ts';
import { normalizeHeader } from '../detect/headerMatch.ts';

const DATE_HEADERS = new Set([
  'date', 'as of', 'as of date', 'asof', 'asof date', 'valuation date', 'report date', 'reporting date', 'position date',
  'positions date', 'holding date', 'holdings date', 'nav date', 'pricing date', 'business date', 'snapshot date',
  'datum', 'per', 'per datum', 'rapportdatum', 'vardering', 'varderingsdatum', 'balansdag', 'innehavsdatum',
  'stichtag', 'bewertungsdatum', 'berichtsdatum', 'date de valorisation', 'date valorisation', 'date d arrete', 'date de l inventaire',
]);
const PORTFOLIO_HEADERS = new Set([
  'portfolio', 'portfolio name', 'portfolio id', 'portfolio code', 'portfolio short name', 'fund', 'fund name', 'fund code',
  'fund id', 'sub fund', 'subfund', 'sub fund name', 'compartment', 'account', 'account name', 'account number', 'account id',
  'portfolj', 'portfoljnamn', 'portfolj id', 'fond', 'fondnamn', 'fondkod', 'konto', 'kontonummer', 'depa', 'depanummer', 'depa nr',
  'depot', 'depotnummer', 'depot nr', 'fonds', 'fondsname', 'teilfonds', 'portefeuille', 'nom du fonds', 'code fonds', 'compte',
]);

export interface TableSplit {
  /** Column (index into table.headers) holding each row's as-of date. */
  dateCol?: number;
  /** Column holding each row's portfolio / fund / account. */
  portfolioCol?: number;
  /** Distinct dates, ISO, oldest first. */
  dates: string[];
  /** Distinct portfolios, in file order. */
  portfolios: string[];
  /** Rows per "portfolio\u0001date" key ("" for a missing part). */
  counts: Record<string, number>;
  /** Rows in the file before the cut. */
  rowsInFile: number;
}

export interface SplitChoice {
  portfolio?: string;
  date?: string;
}

const isBlank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const dateOf = (v: unknown) => (typeof v === 'number' ? excelSerialToIso(v) : parseDate(v, 'DMY'));
const textOf = (v: unknown) => (isBlank(v) ? '' : String(v).trim());
const key = (portfolio: string, date: string) => `${portfolio}\u0001${date}`;

/** The date and portfolio columns of a table, if it has them; undefined for an ordinary one-portfolio file. */
export function detectSplit(table: DetectedTable): TableSplit | undefined {
  const n = table.rows.length;
  if (!n) return undefined;
  const filled = (i: number) => table.rows.filter((r) => !isBlank(r.cells[i])).length;
  let dateCol: number | undefined;
  let portfolioCol: number | undefined;
  table.headers.forEach((h, i) => {
    const name = normalizeHeader(h);
    if (dateCol === undefined && DATE_HEADERS.has(name) && filled(i) >= 0.9 * n) {
      const vals = table.rows.map((r) => r.cells[i]).filter((v) => !isBlank(v));
      if (vals.every((v) => dateOf(v))) dateCol = i;
    }
    if (portfolioCol === undefined && PORTFOLIO_HEADERS.has(name) && filled(i) >= 0.9 * n) {
      const distinct = new Set(table.rows.map((r) => textOf(r.cells[i])).filter(Boolean));
      // A few names, each repeated: a portfolio column, not a list of held funds.
      if (distinct.size >= 1 && distinct.size <= Math.max(1, Math.floor(n / 2))) portfolioCol = i;
    }
  });
  if (dateCol === undefined && portfolioCol === undefined) return undefined;

  const dates = new Set<string>();
  const portfolios: string[] = [];
  const counts: Record<string, number> = {};
  for (const r of table.rows) {
    const d = dateCol === undefined ? '' : (dateOf(r.cells[dateCol]) ?? '');
    const p = portfolioCol === undefined ? '' : textOf(r.cells[portfolioCol]);
    if (d) dates.add(d);
    if (p && !portfolios.includes(p)) portfolios.push(p);
    counts[key(p, d)] = (counts[key(p, d)] ?? 0) + 1;
  }
  return { dateCol, portfolioCol, dates: [...dates].sort(), portfolios, counts, rowsInFile: n };
}

/** Dates that have rows for a portfolio (all dates when the file has no portfolio column). */
export function datesFor(split: TableSplit, portfolio?: string): string[] {
  if (split.portfolioCol === undefined || portfolio === undefined) return split.dates;
  return split.dates.filter((d) => split.counts[key(portfolio, d)]);
}

/** The first portfolio in the file, on its latest date. */
export function defaultChoice(split: TableSplit): SplitChoice {
  const portfolio = split.portfolioCol === undefined ? undefined : split.portfolios[0];
  const date = split.dateCol === undefined ? undefined : datesFor(split, portfolio).at(-1);
  return { portfolio, date };
}

/** True when the file holds more than one (portfolio, date) pair, so the user has to pick one. */
export const needsChoice = (split: TableSplit | undefined) => !!split && (split.dates.length > 1 || split.portfolios.length > 1);

/** The table cut down to the chosen portfolio and date. Totals cover the whole file, so they go when rows are cut. */
export function applySplit(table: DetectedTable, split: TableSplit, choice: SplitChoice): DetectedTable {
  const keep = (r: DataRow) =>
    (split.dateCol === undefined || choice.date === undefined || dateOf(r.cells[split.dateCol]) === choice.date) &&
    (split.portfolioCol === undefined || choice.portfolio === undefined || textOf(r.cells[split.portfolioCol]) === choice.portfolio);
  const rows = table.rows.filter(keep);
  return { ...table, rows, totals: rows.length === table.rows.length ? table.totals : [], split: { ...split, choice } };
}

/** Detect and apply the default choice: what an upload does before the user picks anything. */
export function withDefaultSplit(table: DetectedTable): DetectedTable {
  const split = detectSplit(table);
  return split ? applySplit(table, split, defaultChoice(split)) : table;
}
