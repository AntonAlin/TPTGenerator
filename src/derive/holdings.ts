/**
 * Turn mapped table rows into typed holdings: numbers parsed with each
 * column's decimal separator, dates normalised to ISO, codes upper-cased,
 * weights scaled to TPT convention (1 = 100%), coupons to percent.
 */
import type { CanonicalField } from '../detect/canonical.ts';
import type { AmountInterpretation } from './amounts.ts';
import type { DetectedTable, TotalRow } from '../ingest/table.ts';
import type { RawCell } from '../ingest/readFile.ts';
import { detectDateOrder, detectDecimalSeparator, excelSerialToIso, parseDate, parseNumber, tableDecimalSeparator, type DecimalSeparator } from '../ingest/values.ts';
import { decideScale, metadataScale, minorUnit, scaleHint } from './scale.ts';

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
  dirty_price?: number;
  yield?: number;
  modified_duration?: number;
  spread?: number;
  interest_rate_type?: string;
  /** Coupons per year: 1, 2, 4, 12 (words like "semi-annual" are read as numbers). */
  coupon_frequency?: number;
  call_date?: string;
  cqs?: number;
  rating_agency?: string;
  nace?: string;
  group_name?: string;
  group_lei?: string;
  contract_size?: number;
  strike?: number;
  call_put?: string;
  exercise_type?: string;
  underlying_name?: string;
  underlying_id?: string;
  underlying_price?: number;
  delta?: number;
  /** A forward's or swap's legs: bought / received, and sold / paid (the latter may be negative). */
  leg1_amount?: number;
  leg1_currency?: string;
  leg2_amount?: number;
  leg2_currency?: string;
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
  /** Why the value was rescaled on reading (e.g. the column is in TSEK), if it was. */
  scaled?: string;
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
  /** Values rescaled on reading (thousands, pence), with the reason, by field. */
  scaled?: Partial<Record<keyof FileValues, string>>;
}

export interface NormalizeResult {
  holdings: Holding[];
  /** Column-level notes, e.g. how weights were scaled. */
  notes: string[];
  /** Text of the market value (portfolio currency) header, for guessing the portfolio currency. */
  portfolioValueHeader?: string;
  /** The table's totals with the same scaling applied as the holdings (thousands → units). */
  totals: TotalRow[];
}

const NUMERIC: CanonicalField[] = [
  'quantity', 'nominal', 'market_value_local', 'market_value_portfolio', 'price', 'coupon', 'weight', 'accrued_interest', 'fx_rate', 'amount_mixed',
  'dirty_price', 'yield', 'modified_duration', 'spread', 'cqs', 'contract_size', 'strike', 'underlying_price', 'delta',
  'leg1_amount', 'leg2_amount',
];
const UPPER: CanonicalField[] = ['isin', 'currency', 'issuer_lei', 'country', 'cic', 'group_lei', 'nace', 'leg1_currency', 'leg2_currency'];
const DATES: CanonicalField[] = ['maturity_date', 'call_date'];

/** Coupon payments per year from a number or a word (EN/SV/DE/FR). */
export function frequencyOf(v: string | number): number | undefined {
  if (typeof v === 'number') return [0, 1, 2, 4, 12, 52].includes(v) ? v : undefined;
  const t = v.trim().toLowerCase();
  if (/^(0|1|2|4|12|52)$/.test(t)) return Number(t);
  if (/^(semi[- ]?annual(ly)?|half[- ]?yearly|halvår\w*|halbjährlich|semestriel\w*|s)$/.test(t)) return 2;
  if (/^(annual(ly)?|yearly|årlig\w*|årsvis|jährlich|annuel\w*|a|y)$/.test(t)) return 1;
  if (/^(quarterly|kvartal\w*|vierteljährlich|trimestriel\w*|q)$/.test(t)) return 4;
  if (/^(monthly|månad\w*|månatlig\w*|monatlich|mensuel\w*|m)$/.test(t)) return 12;
  if (/^(weekly|vecko\w*|wöchentlich|hebdomadaire|w)$/.test(t)) return 52;
  return undefined;
}

const blank = (c: RawCell) => c == null || (typeof c === 'string' && !c.trim());
const text = (c: RawCell) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c)).trim();

export function normalizeHoldings(table: DetectedTable, mapping: CanonicalField[]): NormalizeResult {
  const notes: string[] = [];
  const holdings: Holding[] = table.rows.map((r, index) => ({ index, row: r.row, section: r.section, file: {}, unparsed: {} }));
  const set = (h: Holding, f: CanonicalField, v: string | number) => ((h.file as Record<string, string | number>)[f] = v);

  const tableDecimal = tableDecimalSeparator(table.headers.map((_, c) => table.rows.map((r) => r.cells[c])));
  const decimals = new Map<number, DecimalSeparator | undefined>();
  const minorRows = new Map<number, string>();
  mapping.forEach((field, col) => {
    if (field === 'ignore') return;
    const values = table.rows.map((r) => r.cells[col]);
    const strings = values.filter((v): v is string => typeof v === 'string');
    const decimal: DecimalSeparator | undefined = detectDecimalSeparator(strings) ?? tableDecimal;
    if (!detectDecimalSeparator(strings) && tableDecimal && NUMERIC.includes(field) && strings.some((x) => /^\s*-?\d{1,3}[.,]\d{3}\s*$/.test(x))) {
      notes.push(`"${table.headers[col]}": values like "${strings.find((x) => /^\s*-?\d{1,3}[.,]\d{3}\s*$/.test(x))}" are ambiguous on their own; read with the file's decimal ${tableDecimal === ',' ? 'comma' : 'point'}.`);
    }
    const order = detectDateOrder(strings) ?? 'DMY';
    decimals.set(col, decimal);

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
      if (field === 'coupon' || field === 'yield') {
        const pos = nums.filter((x): x is number => x !== undefined && x > 0);
        if (pos.length && Math.max(...pos) < 0.2 && !parsed.some((p) => p?.percent)) {
          factor = 100;
          notes.push(`${field === 'coupon' ? 'Coupons' : 'Yields'} in "${table.headers[col]}" look like fractions (max ${Math.max(...pos)}) and were multiplied by 100.`);
        }
      }
      if (field === 'spread') {
        // A margin in basis points (a header that says bp, or values too large for %) goes to %.
        const max = Math.max(0, ...nums.map((x) => Math.abs(x ?? 0)));
        if (/\b(bps?|bp|basis|pb|punkte|punkter)\b/i.test(table.headers[col]) || max > 20) {
          factor = 0.01;
          notes.push(`Spreads in "${table.headers[col]}" read as basis points and divided by 100 (TPT field 37 is in %).`);
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

    if (field === 'coupon_frequency') {
      values.forEach((v, i) => {
        if (blank(v)) return;
        const f = frequencyOf(typeof v === 'number' ? v : text(v));
        if (f !== undefined) set(holdings[i], field, f);
        else holdings[i].unparsed.coupon_frequency = text(v);
      });
      return;
    }

    if (DATES.includes(field)) {
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
        else holdings[i].unparsed[field as 'maturity_date' | 'call_date'] = text(v);
      });
      return;
    }

    values.forEach((v, i) => {
      if (blank(v)) return;
      const t = text(v);
      // Prices quoted in a minor unit (GBX / GBp pence, ZAc, ILA): the currency is the major one.
      const major = field === 'currency' ? minorUnit(t) : undefined;
      if (major) minorRows.set(i, t);
      set(holdings[i], field, major ?? (UPPER.includes(field) ? t.toUpperCase() : t));
    });
  });

  // Prices in pence and the like: to the major unit, so quantity × price = value.
  for (const [i, code] of minorRows) {
    const h = holdings[i];
    if (h.file.price === undefined) continue;
    h.file.price = h.file.price / 100;
    (h.scaled ??= {}).price = `Price quoted in ${code} (1/100 of ${h.file.currency}): divided by 100`;
  }
  if (minorRows.size) notes.push(`${minorRows.size} price(s) quoted in a minor currency unit (${[...new Set(minorRows.values())].join(', ')}) divided by 100.`);

  // Amounts in thousands or millions.
  const totals = table.totals.map((t) => ({ ...t, cells: [...t.cells] }));
  const meta = metadataScale(table);
  mapping.forEach((field, col) => {
    const monetary = field === 'market_value_local' || field === 'market_value_portfolio' || field === 'accrued_interest';
    const holdingAmount = field === 'quantity' || field === 'nominal' || field === 'amount_mixed';
    if (!monetary && !holdingAmount) return;
    const own = scaleHint(table.headers[col]);
    const hint = own ? { factor: own, source: `the header says so` } : monetary && meta ? { factor: meta.factor, source: `"${meta.line.slice(0, 60)}" above the table` } : undefined;
    if (!hint && !monetary) return;
    const valueOf = (h: Holding) => (field === 'accrued_interest' ? h.file.accrued_interest : h.amountCells?.find((c) => c.col === col)?.value);
    const qOf = (h: Holding) => h.file.quantity ?? h.file.nominal ?? h.amountCells?.find((c) => c.field === 'amount_mixed' || c.field === 'quantity' || c.field === 'nominal')?.value;
    // A holding column in thousands is checked the other way round: value = q × 1000 × price.
    const rows = field === 'accrued_interest' ? [] : holdings.map((h) => (holdingAmount ? { q: valueOf(h), price: h.file.price, value: undefined } : { q: qOf(h), price: h.file.price, value: valueOf(h) }));
    const decision = holdingAmount
      ? hint && decideScale(table.headers[col], hint, holdings.map((h) => {
          const mv = h.amountCells?.find((c) => c.field === 'market_value_local')?.value;
          const q = valueOf(h);
          return { q: mv, price: 1, value: q !== undefined && h.file.price ? q * h.file.price : undefined };
        }))
      : decideScale(table.headers[col], hint, rows);
    if (!decision) return;
    for (const h of holdings) {
      const cell = h.amountCells?.find((c) => c.col === col);
      if (cell) {
        cell.value *= decision.factor;
        cell.scaled = decision.why;
      }
      if (field !== 'amount_mixed' && typeof h.file[field] === 'number') {
        (h.file as Record<string, number>)[field] *= decision.factor;
        (h.scaled ??= {})[field] = decision.why;
      }
    }
    for (const t of totals) {
      const n = parseNumber(t.cells[col], decimals.get(col))?.value;
      if (n !== undefined) t.cells[col] = n * decision.factor;
    }
    notes.push(`${decision.why}.`);
  });

  const pvCol = mapping.indexOf('market_value_portfolio');
  return { holdings, notes, totals, portfolioValueHeader: pvCol >= 0 ? table.headers[pvCol] : undefined };
}
