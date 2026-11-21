/**
 * Parsing of raw cell values found in messy holdings files:
 * numbers with decimal comma or point, thousands separators, percentages,
 * accounting negatives, and dates in many formats (including Excel serials).
 */

export type DecimalSeparator = ',' | '.';

export interface ParsedNumber {
  value: number;
  /** True if the text carried a % sign (value is NOT divided by 100 here). */
  percent: boolean;
}

const NBSP = /[   ]/g;

/**
 * Parse a number. With `decimal` unspecified the separator is guessed per value:
 * "1.234,56" → 1234.56, "1,234.56" → 1234.56, "0,75" → 0.75, "1,234" → 1234
 * (ambiguous single comma with exactly 3 trailing digits is read as thousands
 * unless `decimal` is ','). Returns undefined for non-numeric text.
 */
export function parseNumber(raw: unknown, decimal?: DecimalSeparator): ParsedNumber | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, percent: false } : undefined;
  if (typeof raw !== 'string') return undefined;
  let s = raw.replace(NBSP, ' ').trim();
  if (!s) return undefined;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  // Strip a currency code or symbol prefix/suffix such as "SEK 1 000" or "1,000 €".
  s = s.replace(/^([A-Z]{3}|[$€£¥])\s*/, '').replace(/\s*([A-Z]{3}|[$€£¥])$/, '');
  if (/^[-+−]/.test(s)) {
    negative = negative !== /^[-−]/.test(s);
    s = s.slice(1).trim();
  }
  if (s.endsWith('-')) {
    // Trailing minus used by some systems: "1234.50-"
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  // Thousands separators that are unambiguous: spaces and apostrophes.
  s = s.replace(/[ ']/g, '');
  if (!/^[0-9.,]+([eE][-+]?\d+)?$/.test(s) || !/\d/.test(s)) return undefined;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let dec: DecimalSeparator | undefined = decimal;
  if (!dec) {
    if (lastComma >= 0 && lastDot >= 0) dec = lastComma > lastDot ? ',' : '.';
    else if (lastComma >= 0) {
      const commas = s.split(',').length - 1;
      const tail = s.length - lastComma - 1;
      dec = commas === 1 && tail !== 3 ? ',' : '.';
    } else dec = '.';
  }
  const thousands = dec === ',' ? '.' : ',';
  // Validate thousands grouping if present.
  const [intPart, ...fracParts] = s.split(dec);
  if (fracParts.length > 1) return undefined;
  if (intPart.includes(thousands)) {
    const groups = intPart.split(thousands);
    if (groups.slice(1).some((g) => g.length !== 3) || groups[0].length === 0 || groups[0].length > 3) return undefined;
  }
  if (fracParts[0]?.includes(thousands)) return undefined;
  const normalized = intPart.split(thousands).join('') + (fracParts.length ? `.${fracParts[0]}` : '');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  return { value: negative ? -value : value, percent };
}

/**
 * Decide which decimal separator a column uses, from all its values.
 * Returns undefined if the column gives no evidence either way.
 */
export function detectDecimalSeparator(values: unknown[]): DecimalSeparator | undefined {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.replace(NBSP, '').replace(/[ ']/g, '').trim();
    if (!/^[-+(]?[0-9.,]+%?\)?-?$/.test(s)) continue;
    const lc = s.lastIndexOf(',');
    const ld = s.lastIndexOf('.');
    if (lc >= 0 && ld >= 0) (lc > ld ? comma++ : dot++);
    else if (lc >= 0 && s.length - lc - 1 !== 3) comma++;
    else if (ld >= 0 && s.length - ld - 1 !== 3) dot++;
    else if (ld >= 0 && (s.split('.').length - 1) > 1) comma++; // 1.234.567 → dot is thousands
    else if (lc >= 0 && (s.split(',').length - 1) > 1) dot++;
  }
  if (comma === 0 && dot === 0) return undefined;
  return comma > dot ? ',' : '.';
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type DateOrder = 'DMY' | 'MDY';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // Swedish / German / French variants
  maj: 5, okt: 10, mär: 3, mrz: 3, mai: 5, dez: 12, janv: 1, févr: 2, fevr: 2, mars: 3, avr: 4, juin: 6,
  juil: 7, août: 8, aout: 8, sept: 9, déc: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const expandYear = (y: number) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/** Convert an Excel serial date (1900 system) to ISO. Only plausible range 1950–2200. */
export function excelSerialToIso(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial < 18264 || serial > 109574) return undefined;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Parse a date in common formats to "YYYY-MM-DD". `order` resolves
 * ambiguous numeric dates like 03/04/2025 (default day-first, European).
 */
export function parseDate(raw: unknown, order: DateOrder = 'DMY'): string | undefined {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? undefined : isoDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }
  if (typeof raw === 'number') return undefined; // serials are handled explicitly by callers
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  let m: RegExpExecArray | null;
  // ISO and ISO-like: 2025-03-31, 2025/03/31, 2025.03.31, with optional time
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t ].*)?$/.exec(s))) return isoDate(+m[1], +m[2], +m[3]);
  // Compact: 20250331
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return isoDate(+m[1], +m[2], +m[3]);
  // Numeric with day/month ambiguity: 31/03/2025, 3.4.25, 03-31-2025
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
    const a = +m[1];
    const b = +m[2];
    const y = expandYear(+m[3]);
    if (a > 12) return isoDate(y, b, a);
    if (b > 12) return isoDate(y, a, b);
    return order === 'DMY' ? isoDate(y, b, a) : isoDate(y, a, b);
  }
  // Month names: 15-NOV-32, 15 Nov 2032, Nov 15 2032, 15. november 2032
  if ((m = /^(\d{1,2})\.?[\s-/]*([a-zéûä]{3,9})\.?[\s-/,]*(\d{2}|\d{4})$/.exec(s))) {
    const mon = monthFromName(m[2]);
    return mon ? isoDate(expandYear(+m[3]), mon, +m[1]) : undefined;
  }
  if ((m = /^([a-zéûä]{3,9})\.?[\s-/]*(\d{1,2}),?[\s-/]*(\d{2}|\d{4})$/.exec(s))) {
    const mon = monthFromName(m[1]);
    return mon ? isoDate(expandYear(+m[3]), mon, +m[2]) : undefined;
  }
  return undefined;
}

function monthFromName(name: string): number | undefined {
  const n = name.replace(/\.$/, '');
  if (MONTHS[n]) return MONTHS[n];
  for (const len of [4, 3]) {
    const k = n.slice(0, len);
    if (MONTHS[k]) return MONTHS[k];
  }
  return undefined;
}

/** Guess whether ambiguous numeric dates in a column are day-first or month-first. */
export function detectDateOrder(values: unknown[]): DateOrder | undefined {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\s*$/.exec(v);
    if (!m) continue;
    if (+m[1] > 12) dmy++;
    else if (+m[2] > 12) mdy++;
  }
  if (!dmy && !mdy) return undefined;
  return dmy >= mdy ? 'DMY' : 'MDY';
}
