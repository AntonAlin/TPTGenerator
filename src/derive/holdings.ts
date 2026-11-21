/**
 * Turn mapped table rows into typed holdings: numbers parsed with each
 * column's decimal separator, dates normalised to ISO, codes upper-cased,
 * weights scaled to TPT convention (1 = 100%), coupons to percent.
 */
import type { CanonicalField } from '../detect/canonical.ts';
import type { AmountInterpretation } from './amounts.ts';
import type { DetectedTable } from '../ingest/table.ts';
import type { RawCell } from '../ingest/readFile.ts';
import { detectDateOrder, detectDecimalSeparator, excelSerialToIso, parseDate, parseNumber, tableDecimalSeparator, type DecimalSeparator } from '../ingest/values.ts';

export interface FileValues {
  isin?: string;
  other_identifier?: string;
  security_name?: string;
  quantity?: number;
  nominal?: number;
  market_value_local?: number;
  market_value_portfolio?: number;
  price?: number;
  currency?: string;
  coupon?: number;
  maturity_date?: string;
  asset_type?: string;
  weight?: number;
  rating?: string;
  issuer_name?: string;
  issuer_lei?: string;
  country?: string;
  accrued_interest?: number;
  fx_rate?: number;
  cic?: string;
}

/** Columns whose cells are amounts that may need re-sorting per row (see derive/amounts.ts). */
export const AMOUNT_FIELDS = ['quantity', 'nominal', 'market_value_local', 'market_value_portfolio', 'amount_mixed'] as const;
export type AmountField = (typeof AMOUNT_FIELDS)[number];

/** One numeric cell from an amount column, before deciding what it really is. */
export interface AmountCell {
  /** Index of the column in the table. */
  col: number;
  header: string;
  /** What the column was mapped to. */
  field: AmountField;
  value: number;
}

export interface Holding {
  /** 0-based index in the holdings list. */
  index: number;
  /** 0-based row in the source sheet. */
  row: number;
  section?: string;
  file: FileValues;
  /** Every amount cell of the row, in column order (input to derive/amounts.ts). */
  amountCells?: AmountCell[];
  /** How the amount cells were interpreted (set by derive/amounts.ts). */
  amounts?: AmountInterpretation;
  /** Values present in the file that could not be parsed (kept for the quality report). */
  unparsed: Partial<Record<keyof FileValues, string>>;
}

export interface NormalizeResult {
  holdings: Holding[];
  /** Column-level notes, e.g. how weights were scaled. */
  notes: string[];
  /** Text of the market value (portfolio currency) header, for guessing the portfolio currency. */
  portfolioValueHeader?: string;
}

const NUMERIC: CanonicalField[] = ['quantity', 'nominal', 'market_value_local', 'market_value_portfolio', 'price', 'coupon', 'weight', 'accrued_interest', 'fx_rate', 'amount_mixed'];
const UPPER: CanonicalField[] = ['isin', 'currency', 'issuer_lei', 'country', 'cic'];

const blank = (c: RawCell) => c == null || (typeof c === 'string' && !c.trim());
const text = (c: RawCell) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c)).trim();

export function normalizeHoldings(table: DetectedTable, mapping: CanonicalField[]): NormalizeResult {
  const notes: string[] = [];
  const holdings: Holding[] = table.rows.map((r, index) => ({ index, row: r.row, section: r.section, file: {}, unparsed: {} }));
  const set = (h: Holding, f: CanonicalField, v: string | number) => ((h.file as Record<string, string | number>)[f] = v);

  const tableDecimal = tableDecimalSeparator(table.headers.map((_, c) => table.rows.map((r) => r.cells[c])));
  mapping.forEach((field, col) => {
    if (field === 'ignore') return;
    const values = table.rows.map((r) => r.cells[col]);
    const strings = values.filter((v): v is string => typeof v === 'string');
    const decimal: DecimalSeparator | undefined = detectDecimalSeparator(strings) ?? tableDecimal;
    if (!detectDecimalSeparator(strings) && tableDecimal && NUMERIC.includes(field) && strings.some((x) => /^\s*-?\d{1,3}[.,]\d{3}\s*$/.test(x))) {
      notes.push(`"${table.headers[col]}": values like "${strings.find((x) => /^\s*-?\d{1,3}[.,]\d{3}\s*$/.test(x))}" are ambiguous on their own; read with the file's decimal ${tableDecimal === ',' ? 'comma' : 'point'}.`);
    }
    const order = detectDateOrder(strings) ?? 'DMY';

    if (NUMERIC.includes(field)) {
      const parsed = values.map((v) => (blank(v) ? undefined : parseNumber(v, decimal)));
      const nums = parsed.map((p) => p?.value);
      let factor = 1;
      if (field === 'weight') {
        const sum = nums.reduce<number>((s, x) => s + (x ?? 0), 0);
        const anyPct = parsed.some((p) => p?.percent);
        const max = Math.max(0, ...nums.map((x) => Math.abs(x ?? 0)));
        if (anyPct || Math.abs(sum - 100) <= 5 || max > 1.5) {
          factor = 0.01;
          notes.push(`Weights in "${table.headers[col]}" read as percentages (sum ${sum.toFixed(2)}) and divided by 100 (TPT: 1 = 100%).`);
        } else notes.push(`Weights in "${table.headers[col]}" read as fractions (sum ${sum.toFixed(4)}).`);
      }
      if (field === 'coupon') {
        const pos = nums.filter((x): x is number => x !== undefined && x > 0);
        if (pos.length && Math.max(...pos) < 0.2 && !parsed.some((p) => p?.percent)) {
          factor = 100;
          notes.push(`Coupons in "${table.headers[col]}" look like fractions (max ${Math.max(...pos)}) and were multiplied by 100.`);
        }
      }
      const isAmount = (AMOUNT_FIELDS as readonly string[]).includes(field);
      parsed.forEach((p, i) => {
        if (p && isAmount) (holdings[i].amountCells ??= []).push({ col, header: table.headers[col], field: field as AmountField, value: p.value });
        // Mixed columns are only placed into fields once each cell is interpreted (derive/amounts.ts).
        if (p && field !== 'amount_mixed') set(holdings[i], field, p.value * factor);
        else if (!blank(values[i]) && field !== 'amount_mixed') holdings[i].unparsed[field as keyof FileValues] = text(values[i]);
      });
      return;
    }

    if (field === 'maturity_date') {
      values.forEach((v, i) => {
        if (blank(v)) return;
        const iso =
          v instanceof Date
            ? parseDate(v)
            : typeof v === 'number'
              ? excelSerialToIso(v)
              : /^\s*(perp(etual)?|evig)\s*$/i.test(String(v))
                ? '9999-12-31'
                : parseDate(v, order);
        if (iso) set(holdings[i], field, iso);
        else holdings[i].unparsed.maturity_date = text(v);
      });
      return;
    }

    values.forEach((v, i) => {
      if (blank(v)) return;
      const t = text(v);
      set(holdings[i], field, UPPER.includes(field) ? t.toUpperCase() : t);
    });
  });

  const pvCol = mapping.indexOf('market_value_portfolio');
  return { holdings, notes, portfolioValueHeader: pvCol >= 0 ? table.headers[pvCol] : undefined };
}
