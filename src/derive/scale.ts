/**
 * Units and scale of amount columns: values reported in thousands or millions ("TSEK", "000s",
 * "Belopp i tusental kronor", "MEUR"), and prices quoted in a minor currency unit (pence: GBX/GBp,
 * South African cents ZAc, Israeli agorot ILA).
 *
 * A hint in the column header or in the title rows is only a hint: the scale is confirmed (or
 * overruled) by the rows themselves, quantity × price against the value. A scale nobody wrote
 * down is found the same way. Every scaled column and row says why in a note.
 */
import type { DetectedTable } from '../ingest/table.ts';

const CCY = 'SEK|EUR|USD|NOK|DKK|GBP|CHF|JPY|CAD|AUD|ISK|PLN|CZK|HUF';
const THOUSANDS: RegExp[] = [
  new RegExp(`(?:^|[^A-Za-z])[TtKk](?:${CCY}|kr)(?![A-Za-z])`),
  /\btkr\b|\bksek\b/i,
  /(?:^|[\s(])'?000'?s?(?:\)|$|\s)|\(\s*0{3}\s*\)|\bin 0{3}\b|\b0{3}'?s\b/i,
  /\bthousands?\b|\btusental\b|\btsd\.?(?=\s|$)|\btausend\b|\bmilliers?\b/i,
];
const MILLIONS: RegExp[] = [new RegExp(`(?:^|[^A-Za-z])M(?:${CCY})(?![A-Za-z])`), /\bmkr\b|\bmillions?\b|\bmiljoner\b|\bmio\.?(?=\s|$)|\bmn\b/i];

/** Scale written in a header or a title line: 1000, 1e6, or undefined. */
export function scaleHint(text: string): number | undefined {
  if (MILLIONS.some((re) => re.test(text))) return 1e6;
  if (THOUSANDS.some((re) => re.test(text))) return 1000;
  return undefined;
}

/** A scale stated in the rows above the table ("Belopp i tusental kronor", "Amounts in EUR 000s"). */
export function metadataScale(table: DetectedTable): { factor: number; line: string } | undefined {
  for (const s of table.skipped) {
    if (s.reason !== 'above-header') continue;
    // Only lines that talk about amounts, not a fund called "Million Fund".
    if (!/(belopp|amount|value|v[aä]rde|betr[aä]g|montant|valeur|figures|in |i |en )/i.test(s.preview)) continue;
    const f = scaleHint(s.preview);
    if (f) return { factor: f, line: s.preview };
  }
  return undefined;
}

/** Minor-unit currency codes and their major currency. Prices in these are divided by 100. */
export const MINOR_UNITS: Record<string, string> = { GBX: 'GBP', GBp: 'GBP', GBx: 'GBP', ZAc: 'ZAR', ZAC: 'ZAR', ILA: 'ILS', ILa: 'ILS', ILs: 'ILS' };
/** Currency text as written ("GBp", "GBX", "ZAc") → its major currency, when prices are in the minor unit. */
export function minorUnit(raw: string): string | undefined {
  const t = raw.trim();
  // Case matters for GBp vs GBP; GBX in any case is pence.
  return MINOR_UNITS[t] ?? (t.toUpperCase() === 'GBX' ? 'GBP' : undefined);
}

export interface RowAmounts {
  /** Quantity or nominal (whichever the row has; mixed columns give the raw cell). */
  q?: number;
  price?: number;
  /** Value in this column, as written. */
  value?: number;
}

/**
 * The scale of one value column from the rows: quantity × price (or nominal × price ÷ 100)
 * against the value. Returns the factor most rows agree on, with how many rows could be checked.
 */
export function scaleFromRows(rows: RowAmounts[]): { factor: number; agree: number; checked: number } {
  const counts = new Map<number, number>();
  let checked = 0;
  for (const r of rows) {
    if (r.q === undefined || r.price === undefined || !r.value || !r.q || !r.price) continue;
    const ratio = Math.abs((r.q * r.price) / r.value);
    // Units (q × p) or a bond in % of nominal (q × p ÷ 100). A row that fits no scale (another
    // currency in a portfolio-currency column, a derivative) says nothing about the scale.
    const fits = [1, 1000, 1e6].filter((f) => Math.abs(ratio / f - 1) < 0.01 || Math.abs(ratio / (100 * f) - 1) < 0.01);
    if (!fits.length) continue;
    checked++;
    for (const f of fits) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best = { factor: 1, agree: 0, checked };
  for (const [f, n] of counts) if (n > best.agree) best = { factor: f, agree: n, checked };
  return best;
}

export interface ColumnScaleDecision {
  factor: number;
  why: string;
}

/**
 * Decide a column's scale from the hints and the rows. A hint stands unless the rows clearly show
 * the values are not scaled; without a hint the rows must clearly agree (half the checkable rows,
 * at least three) before anything is multiplied.
 */
export function decideScale(header: string, hint: { factor: number; source: string } | undefined, rows: RowAmounts[]): ColumnScaleDecision | undefined {
  const fromRows = scaleFromRows(rows);
  const clear = fromRows.agree >= 3 && fromRows.agree >= fromRows.checked / 2;
  const mult = (f: number) => (f === 1e6 ? 'a million' : 'a thousand');
  if (hint) {
    if (clear && fromRows.factor === 1) return undefined; // The rows say the values are already in units.
    const confirm = clear && fromRows.factor === hint.factor ? `; quantity × price confirms it in ${fromRows.agree} of ${fromRows.checked} rows` : '';
    return { factor: hint.factor, why: `"${header}" is in ${mult(hint.factor)}s (${hint.source})${confirm}: multiplied by ${hint.factor.toLocaleString('en-US')}` };
  }
  if (clear && fromRows.factor > 1) {
    return { factor: fromRows.factor, why: `"${header}" is in ${mult(fromRows.factor)}s: quantity × price is ${fromRows.factor.toLocaleString('en-US')} × the value in ${fromRows.agree} of ${fromRows.checked} rows; multiplied by ${fromRows.factor.toLocaleString('en-US')}` };
  }
  return undefined;
}
