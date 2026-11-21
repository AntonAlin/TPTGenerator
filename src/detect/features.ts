/**
 * Feature extraction for column classification.
 *
 * IMPORTANT: this exact code is used both in the browser and by the training
 * pipeline (scripts/extract-features.ts), so features at training time and at
 * inference time are identical. If you change a feature, retrain the model.
 */
import { isValidIsin, isValidLei, looksLikeIsin } from '../ingest/identifiers.ts';
import type { RawCell } from '../ingest/readFile.ts';
import { detectDecimalSeparator, detectDateOrder, parseDate, parseNumber, tableDecimalSeparator, type DecimalSeparator } from '../ingest/values.ts';
import { isCountry, isTptCurrency } from '../data/iso.ts';
import { parseCic } from '../data/cic.ts';
import { CANONICAL_FIELDS, type CanonicalField } from './canonical.ts';
import { matchHeader, normalizeHeader, type HeaderMatch } from './headerMatch.ts';

/** Header similarity features cover every field including "ignore" (headers that are typically not needed). */
const HEADER_FIELDS = CANONICAL_FIELDS;
/** Header similarities below this are treated as "no match" so unrelated headers add no noise. */
const HEADER_FLOOR = 0.5;

export const FEATURE_NAMES: string[] = [
  ...HEADER_FIELDS.map((f) => `hdr_${f}`),
  'hdr_ccy_token',
  'hdr_local_token',
  'hdr_base_token',
  'hdr_pct_token',
  'hdr_date_token',
  'hdr_generic',
  'fill',
  'isin_valid',
  'isin_shape',
  'lei_valid',
  'currency',
  'country',
  'cic',
  'rating',
  'date',
  'date_spread',
  'date_unique',
  'date_later',
  'numeric',
  'integer',
  'negative',
  'pct_sign',
  'log_mag',
  'in_0_1',
  'in_0_20',
  'in_50_150',
  'sum_100',
  'sum_1',
  'mag_rank',
  'product_of_others',
  'factor_of_product',
  'share_of_other',
  'units_rows',
  'par_rows',
  'equal_rows',
  'role_mix',
  'row_id',
  'unique',
  'text',
  'text_len',
  'words',
  'asset_kw',
  'name_like',
  'id_like',
  'upper_code',
];

export interface ColumnInput {
  header: string;
  values: RawCell[];
}

export interface ColumnProfile {
  header: string;
  headerMatches: Record<CanonicalField, HeaderMatch>;
  decimal?: DecimalSeparator;
  nonEmpty: number;
  numbers: (number | undefined)[];
  dates: (string | undefined)[];
  stats: Record<string, number>;
}

const isBlank = (c: RawCell) => c == null || (typeof c === 'string' && c.trim() === '');
const str = (c: RawCell) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c)).trim();

const LOCAL_TOKENS = new Set(['local', 'lokal', 'lokalt', 'lc', 'qc', 'lcl', 'instrument', 'trade', 'handelswahrung', 'fw', 'devise', 'locale', 'quotation', 'native', 'security', 'issue']);
const BASE_TOKENS = new Set(['base', 'bas', 'basvaluta', 'portfolio', 'portfolj', 'portfoljvaluta', 'fund', 'fond', 'fonds', 'fondvaluta', 'fondswahrung', 'reporting', 'pc', 'bc', 'rc', 'reference', 'referenz', 'basiswahrung', 'portfoliowahrung', 'book']);
const PCT_TOKENS = new Set(['%', 'pct', 'percent', 'procent', 'prozent', 'pourcent', 'weight', 'vikt']);
const DATE_TOKENS = new Set(['date', 'datum', 'dag', 'dt', 'day', 'echeance', 'falligkeit', 'maturity', 'expiry']);
const GENERIC_RE = /^(column|col|kolumn|spalte|colonne|field|unnamed|f)\s*\d*$/;

const RATING_RE = /^(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|CCC[+-]?|CC|C|D|SD|Aaa|Aa[123]|A[123]|Baa[123]|Ba[123]|B[123]|Caa[123]|Ca|NR|WR|N\.?R\.?|A-1\+?|A-[23]|P-[123])( ?\*?[+-]?| \(.*\))?$/;
const ASSET_KW_RE =
  /\b(equit(y|ies)|stocks?|shares?|aktie[rn]?|bonds?|obligation(er|s)?|anleihen?|renten?|funds?|fond(er|s)?|etf|ucits|cash|kassa|likvid(a|itet)|deposit[s]?|inl[aå]ning|futures?|options?|swaps?|forwards?|termin(er)?|derivat(e|ives?)?|warrants?|certifikat|zertifikat|money market|penningmarknad|actions?|opcvm|structured|convertibles?|government|corporate|covered|treasury|stat(s)?obligation|f[oö]retagsobligation|real estate|fastighet|immobilien|commodit(y|ies)|other|övrigt|sonstige|autres)\b/i;
const NAME_SUFFIX_RE = /\b(ab|ag|sa|plc|inc|ltd|corp|nv|se|asa|oyj|spa|gmbh|co|bank|group|holding|fund|fonds?|etf|bond|frn|%|\d{4})\b/i;

function round(x: number, d = 4) {
  return Math.round(x * 10 ** d) / 10 ** d;
}

/** Compute per-column statistics that do not depend on other columns. */
export function profileColumn(col: ColumnInput, sampleLimit = 400, fallbackDecimal?: DecimalSeparator): ColumnProfile {
  const present = col.values.filter((v) => !isBlank(v));
  const sample = present.slice(0, sampleLimit);
  const strings = sample.filter((v): v is string => typeof v === 'string');
  const decimal = detectDecimalSeparator(strings) ?? fallbackDecimal;
  const order = detectDateOrder(strings) ?? 'DMY';
  const n = Math.max(sample.length, 1);

  const numbers = col.values.map((v) => (isBlank(v) || v instanceof Date ? undefined : parseNumber(v, decimal)?.value));
  const dates = col.values.map((v) => (isBlank(v) ? undefined : parseDate(v instanceof Date ? v : typeof v === 'string' ? v : undefined, order)));

  let isinValid = 0, isinShape = 0, lei = 0, ccy = 0, ctry = 0, cic = 0, rating = 0, pct = 0, text = 0, kw = 0, nameLike = 0, idLike = 0, upper = 0;
  let textLen = 0, words = 0;
  for (const v of sample) {
    const s = str(v);
    if (isValidIsin(s)) isinValid++;
    if (looksLikeIsin(s)) isinShape++;
    if (isValidLei(s)) lei++;
    if (/^[A-Za-z]{3}$/.test(s) && isTptCurrency(s.toUpperCase())) ccy++;
    if (/^[A-Za-z]{2}$/.test(s) && isCountry(s.toUpperCase())) ctry++;
    if (/^[A-Z]{2}[0-9A-F][0-9]$/.test(s) && parseCic(s).valid) cic++;
    if (RATING_RE.test(s)) rating++;
    if (typeof v === 'string' && /%\s*\)?$/.test(s)) pct++;
    const isNum = typeof v === 'number' || (typeof v === 'string' && parseNumber(v, decimal) !== undefined);
    if (!isNum && !(v instanceof Date) && typeof v !== 'boolean') {
      text++;
      textLen += s.length;
      words += s.split(/\s+/).length;
      if (ASSET_KW_RE.test(s)) kw++;
      if (/[a-z]/i.test(s) && (s.split(/\s+/).length >= 2 || NAME_SUFFIX_RE.test(s)) && s.length >= 5) nameLike++;
      if (/^[A-Za-z0-9.\-/:]{4,18}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s) && !looksLikeIsin(s)) idLike++;
      if (/^[A-Z0-9_\-/]{1,8}$/.test(s) && /[A-Z]/.test(s)) upper++;
    }
  }

  const nums = numbers.filter((x): x is number => x !== undefined);
  const nn = Math.max(nums.length, 1);
  const abs = nums.map(Math.abs).filter((x) => x > 0).sort((a, b) => a - b);
  const median = abs.length ? abs[Math.floor(abs.length / 2)] : 0;
  const sum = nums.reduce((a, b) => a + b, 0);
  const isoDates = dates.filter((d): d is string => d !== undefined);
  const times = isoDates.map((d) => Date.parse(d)).sort((a, b) => a - b);
  const spreadYears = times.length > 1 ? (times[times.length - 1] - times[0]) / (365.25 * 864e5) : 0;

  // Row-id: integers increasing by exactly 1 most of the time.
  let steps = 0;
  for (let i = 1; i < numbers.length; i++) {
    const a = numbers[i - 1];
    const b = numbers[i];
    if (a !== undefined && b !== undefined && b - a === 1) steps++;
  }

  const stats: Record<string, number> = {
    fill: present.length / Math.max(col.values.length, 1),
    isin_valid: isinValid / n,
    isin_shape: isinShape / n,
    lei_valid: lei / n,
    currency: ccy / n,
    country: ctry / n,
    cic: cic / n,
    rating: rating / n,
    date: isoDates.length / Math.max(present.length, 1),
    date_spread: Math.min(1, spreadYears / 10),
    date_unique: isoDates.length ? new Set(isoDates).size / isoDates.length : 0,
    numeric: nums.length / Math.max(present.length, 1),
    integer: nums.length ? nums.filter((x) => Number.isInteger(x)).length / nn : 0,
    negative: nums.length ? nums.filter((x) => x < 0).length / nn : 0,
    pct_sign: pct / n,
    log_mag: median > 0 ? Math.max(-1, Math.min(1, Math.log10(median) / 8)) : 0,
    in_0_1: nums.length ? nums.filter((x) => x >= 0 && x <= 1).length / nn : 0,
    in_0_20: nums.length ? nums.filter((x) => x >= 0 && x <= 20).length / nn : 0,
    in_50_150: nums.length ? nums.filter((x) => x >= 50 && x <= 150).length / nn : 0,
    sum_100: nums.length >= 2 && Math.abs(sum - 100) <= 2 ? 1 : 0,
    sum_1: nums.length >= 2 && Math.abs(sum - 1) <= 0.02 ? 1 : 0,
    row_id: numbers.length > 2 ? steps / (numbers.length - 1) : 0,
    unique: present.length ? new Set(present.map(str)).size / present.length : 0,
    text: text / n,
    text_len: text ? Math.min(1, textLen / text / 60) : 0,
    words: text ? Math.min(1, words / text / 8) : 0,
    asset_kw: kw / n,
    name_like: nameLike / n,
    id_like: idLike / n,
    upper_code: upper / n,
  };
  return { header: col.header, headerMatches: matchHeader(col.header), decimal, nonEmpty: present.length, numbers, dates, stats };
}

function headerTokenFeatures(header: string) {
  const norm = normalizeHeader(header);
  const tokens = norm.split(' ').filter(Boolean);
  const rawTokens = header.split(/[^A-Za-z]+/).filter(Boolean);
  return {
    hdr_ccy_token: rawTokens.some((t) => t.length === 3 && t === t.toUpperCase() && isTptCurrency(t)) || tokens.some((t) => ['sek', 'eur', 'usd', 'nok', 'dkk', 'gbp', 'chf'].includes(t)) ? 1 : 0,
    hdr_local_token: tokens.some((t) => LOCAL_TOKENS.has(t)) ? 1 : 0,
    hdr_base_token: tokens.some((t) => BASE_TOKENS.has(t)) ? 1 : 0,
    hdr_pct_token: tokens.some((t) => PCT_TOKENS.has(t)) ? 1 : 0,
    hdr_date_token: tokens.some((t) => DATE_TOKENS.has(t)) ? 1 : 0,
    hdr_generic: !norm || GENERIC_RE.test(norm) ? 1 : 0,
  };
}

/** Relative tolerance check used by the cross-column features. */
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.02);

/**
 * Cross-column features: magnitude rank, "this column = a × b (÷100)",
 * "this column is a factor of such a product", "this column = other / sum(other)".
 */
function crossColumnFeatures(profiles: ColumnProfile[]): Record<string, number>[] {
  const numericIdx = profiles.map((p, i) => (p.stats.numeric >= 0.8 && p.nonEmpty >= 2 ? i : -1)).filter((i) => i >= 0);
  const out = profiles.map(() => ({ mag_rank: 0, product_of_others: 0, factor_of_product: 0, share_of_other: 0, date_later: 0.5, units_rows: 0, par_rows: 0, equal_rows: 0, role_mix: 0 }));

  const medians = numericIdx.map((i) => {
    const a = profiles[i].numbers.filter((x): x is number => x !== undefined).map(Math.abs).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  });
  const order = [...numericIdx.keys()].sort((a, b) => medians[a] - medians[b]);
  order.forEach((k, rank) => {
    out[numericIdx[k]].mag_rank = numericIdx.length > 1 ? rank / (numericIdx.length - 1) : 1;
  });

  const rows = profiles[0]?.numbers.length ?? 0;
  const check = Math.min(rows, 300);
  const frac = (fn: (r: number) => boolean | undefined) => {
    let ok = 0, seen = 0;
    for (let r = 0; r < check; r++) {
      const v = fn(r);
      if (v === undefined) continue;
      seen++;
      if (v) ok++;
    }
    return seen >= 2 ? ok / seen : 0;
  };
  for (const t of numericIdx) {
    for (const a of numericIdx) {
      if (a === t) continue;
      for (const b of numericIdx) {
        if (b <= a || b === t) continue;
        const f = frac((r) => {
          const x = profiles[a].numbers[r], y = profiles[b].numbers[r], z = profiles[t].numbers[r];
          if (x === undefined || y === undefined || z === undefined || z === 0) return undefined;
          return close(x * y, z) || close((x * y) / 100, z);
        });
        if (f > out[t].product_of_others) out[t].product_of_others = f;
        if (f >= 0.7) {
          out[a].factor_of_product = Math.max(out[a].factor_of_product, f);
          out[b].factor_of_product = Math.max(out[b].factor_of_product, f);
        }
      }
      const total = profiles[a].numbers.reduce<number>((s, x) => s + (x ?? 0), 0);
      if (total !== 0) {
        const f = frac((r) => {
          const x = profiles[a].numbers[r], z = profiles[t].numbers[r];
          if (x === undefined || z === undefined) return undefined;
          return close(x / total, z) || close((x / total) * 100, z);
        });
        out[t].share_of_other = Math.max(out[t].share_of_other, f);
      }
    }
  }

  // Row-level behaviour of each amount-like column: in how many rows is it
  //   a units factor  (this × other = third, e.g. shares × price = value),
  //   a par factor    (this × other ÷ 100 = third, e.g. nominal × price % = value),
  //   equal to another column (e.g. a cash balance = its market value)?
  // A column that behaves differently in different rows is likely a mixed amount column.
  for (const t of numericIdx) {
    let units = 0, par = 0, equal = 0, seen = 0;
    for (let r = 0; r < check; r++) {
      const x = profiles[t].numbers[r];
      if (x === undefined || x === 0) continue;
      seen++;
      let u = false, p = false, e = false;
      for (const a of numericIdx) {
        if (a === t) continue;
        const y = profiles[a].numbers[r];
        if (y === undefined) continue;
        if (y !== 0 && close(x, y)) e = true;
        for (const b of numericIdx) {
          if (b === t || b === a) continue;
          const z = profiles[b].numbers[r];
          if (z === undefined || z === 0 || y === 0) continue;
          if (!u && close(x * y, z)) u = true;
          if (!p && close((x * y) / 100, z)) p = true;
        }
      }
      if (u) units++;
      if (p) par++;
      if (e && !u && !p) equal++;
    }
    if (seen >= 2) {
      out[t].units_rows = units / seen;
      out[t].par_rows = par / seen;
      out[t].equal_rows = equal / seen;
      // Mixed: behaves as units (× price) in some rows and as a nominal (× price ÷ 100) in others.
      out[t].role_mix = units > 0 && par > 0 ? 1 : 0;
    }
  }

  // Dates later than the other date columns' typical value (maturities vs trade/valuation dates).
  const dateIdx = profiles.map((p, i) => (p.stats.date >= 0.6 ? i : -1)).filter((i) => i >= 0);
  for (const t of dateIdx) {
    const others = dateIdx.filter((i) => i !== t).flatMap((i) => profiles[i].dates.filter((d): d is string => !!d));
    if (!others.length) continue;
    others.sort();
    const med = others[Math.floor(others.length / 2)];
    const own = profiles[t].dates.filter((d): d is string => !!d);
    out[t].date_later = own.length ? own.filter((d) => d > med).length / own.length : 0.5;
  }
  return out;
}

export interface ColumnFeatures {
  profile: ColumnProfile;
  vector: number[];
  named: Record<string, number>;
}

/** Extract the feature vector (in FEATURE_NAMES order) for every column of a table. */
export function extractFeatures(columns: ColumnInput[]): ColumnFeatures[] {
  // Columns that cannot tell their decimal style on their own (e.g. only "94,125") use the table's.
  const tableDecimal = tableDecimalSeparator(columns.map((c) => c.values));
  const profiles = columns.map((c) => profileColumn(c, 400, tableDecimal));
  const cross = crossColumnFeatures(profiles);
  return profiles.map((p, i) => {
    const named: Record<string, number> = {
      ...Object.fromEntries(HEADER_FIELDS.map((f) => [`hdr_${f}`, p.headerMatches[f].score >= HEADER_FLOOR ? p.headerMatches[f].score : 0])),
      ...headerTokenFeatures(p.header),
      ...p.stats,
      ...cross[i],
    };
    const vector = FEATURE_NAMES.map((name) => {
      const v = named[name];
      if (v === undefined) throw new Error(`Feature ${name} not computed`);
      return round(v);
    });
    return { profile: p, vector, named };
  });
}
