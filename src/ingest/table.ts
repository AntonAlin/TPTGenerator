/**
 * Find the holdings table inside a raw sheet: header row offset (including
 * two-row headers), data rows, and rows that must be skipped (blank rows,
 * totals/subtotals, section headings, notes, repeated headers).
 * Every skipped row is reported with a reason so the user can see what happened.
 */
import type { RawCell } from './readFile.ts';
import { parseDate, parseNumber } from './values.ts';

export type SkipReason =
  | 'blank'
  | 'above-header'
  | 'total'
  | 'computed-total'
  | 'section-heading'
  | 'note'
  | 'repeated-header';

export interface SkippedRow {
  /** 0-based row index in the sheet. */
  row: number;
  reason: SkipReason;
  detail: string;
  preview: string;
}

export interface DataRow {
  /** 0-based row index in the sheet. */
  row: number;
  cells: RawCell[];
  /** Text of the most recent section heading row above this row, if any (e.g. "Equities"). */
  section?: string;
}

export interface DetectedTable {
  headerRows: number[];
  headers: string[];
  /** Source column index for each header (empty columns are dropped). */
  columnIndex: number[];
  rows: DataRow[];
  skipped: SkippedRow[];
  droppedColumns: number[];
}

export interface TableOptions {
  /** Force a header row (0-based) instead of detecting it. */
  headerRow?: number;
}

const TOTAL_RE =
  /^(grand\s*total|sub-?\s*total|total|totals|totalt|summa|delsumma|totalsumma|summe|gesamt|insgesamt|zwischensumme|somme|sous-?\s*total|total\s+g[ée]n[ée]ral|sum)\b/i;
const TOTAL_ANYWHERE_RE = /\b(sub-?total|grand total|totalt|summa|delsumma|zwischensumme|sous-total|total\s+portfolio|portfolio\s+total)\b/i;

const isBlank = (c: RawCell) => c == null || (typeof c === 'string' && c.trim() === '');
const isText = (c: RawCell): c is string =>
  typeof c === 'string' && c.trim() !== '' && parseNumber(c) === undefined && parseDate(c) === undefined;
const isNumericLike = (c: RawCell) => typeof c === 'number' || (typeof c === 'string' && parseNumber(c) !== undefined);
const nonEmpty = (row: RawCell[]) => row.filter((c) => !isBlank(c)).length;
const preview = (row: RawCell[]) =>
  row
    .filter((c) => !isBlank(c))
    .slice(0, 6)
    .map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c)))
    .join(' | ')
    .slice(0, 140);

function headerScore(rows: RawCell[][], r: number, width: number): number {
  const row = rows[r];
  const filled = nonEmpty(row);
  if (filled < 2) return -1;
  const textCells = row.filter(isText).length;
  const textRatio = textCells / filled;
  if (textRatio < 0.6) return -1;
  // Look at the next few non-blank rows: a header is followed by data with numbers.
  let dataLike = 0;
  let seen = 0;
  const key = (x: RawCell[]) => x.map((c) => (isBlank(c) ? '' : String(c).trim().toLowerCase())).join('\u0001');
  const own = key(row);
  for (let k = r + 1; k < rows.length && seen < 5; k++) {
    if (nonEmpty(rows[k]) === 0 || key(rows[k]) === own) continue;
    seen++;
    if (rows[k].some(isNumericLike) && nonEmpty(rows[k]) >= Math.min(3, filled)) dataLike++;
  }
  const coverage = filled / Math.max(width, 1);
  const unique = new Set(row.filter(isText).map((c) => c.toLowerCase())).size / Math.max(textCells, 1);
  // Slight preference for earlier rows breaks ties (e.g. a header repeated after a page break).
  return textCells * 1.0 + coverage * 4 + unique * 2 + (seen ? (dataLike / seen) * 6 : 0) - r * 0.01;
}

function isHeaderLabelRow(row: RawCell[]): boolean {
  const filled = nonEmpty(row);
  return filled >= 1 && row.every((c) => isBlank(c) || isText(c));
}

export function detectTable(rows: RawCell[][], options: TableOptions = {}): DetectedTable {
  const width = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  const grid = rows.map((r) => {
    const copy = r.slice(0, width);
    while (copy.length < width) copy.push(null);
    return copy;
  });

  // 1. Header row.
  let headerRow = options.headerRow ?? -1;
  if (headerRow < 0) {
    let best = -1;
    for (let r = 0; r < Math.min(grid.length, 40); r++) {
      const s = headerScore(grid, r, width);
      if (s > best) {
        best = s;
        headerRow = r;
      }
    }
  }
  if (headerRow < 0) throw new Error('No header row found: the sheet has no row with at least two text labels.');

  // 2. Two-row headers: a label row directly above (group labels like "Market value" spanning
  //    "Local | Portfolio"), or a label row directly below that is not data.
  const headerRows = [headerRow];
  const above = grid[headerRow - 1];
  if (
    options.headerRow === undefined &&
    above &&
    nonEmpty(above) >= 2 &&
    isHeaderLabelRow(above) &&
    above.some((c, i) => !isBlank(c) && !isBlank(grid[headerRow][i]) && String(c).trim() !== String(grid[headerRow][i]).trim()) &&
    above.some((c, i) => isBlank(c) && !isBlank(grid[headerRow][i]))
  ) {
    headerRows.unshift(headerRow - 1);
  }
  const below = grid[headerRow + 1];
  if (
    options.headerRow === undefined &&
    below &&
    isHeaderLabelRow(below) &&
    nonEmpty(below) >= 2 &&
    nonEmpty(below) < nonEmpty(grid[headerRow]) &&
    grid[headerRow + 2]?.some(isNumericLike)
  ) {
    headerRows.push(headerRow + 1);
  }

  // 3. Column headers (combined across header rows), dropping columns with no header and no data.
  const lastHeaderRow = headerRows[headerRows.length - 1];
  const columnIndex: number[] = [];
  const headers: string[] = [];
  const droppedColumns: number[] = [];
  const used = new Map<string, number>();
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (const hr of headerRows) {
      const v = grid[hr][c];
      if (!isBlank(v)) {
        const t = String(v instanceof Date ? v.toISOString().slice(0, 10) : v).replace(/\s+/g, ' ').trim();
        if (!parts.includes(t)) parts.push(t);
      }
    }
    const hasData = grid.slice(lastHeaderRow + 1).some((r) => !isBlank(r[c]));
    if (!parts.length && !hasData) {
      droppedColumns.push(c);
      continue;
    }
    let name = parts.join(' ') || `Column ${c + 1}`;
    const n = used.get(name.toLowerCase()) ?? 0;
    used.set(name.toLowerCase(), n + 1);
    if (n) name = `${name} (${n + 1})`;
    columnIndex.push(c);
    headers.push(name);
  }

  // 4. Classify rows.
  const skipped: SkippedRow[] = [];
  for (let r = 0; r < headerRows[0]; r++) {
    if (nonEmpty(grid[r])) skipped.push({ row: r, reason: 'above-header', detail: 'Title or metadata above the table', preview: preview(grid[r]) });
  }
  const headerKey = grid[headerRow].map((c) => (isBlank(c) ? '' : String(c).trim().toLowerCase())).join('\u0001');
  const candidates: DataRow[] = [];
  let section: string | undefined;
  const typicalFilled = medianFilled(grid.slice(lastHeaderRow + 1));
  for (let r = lastHeaderRow + 1; r < grid.length; r++) {
    const row = grid[r];
    const filled = nonEmpty(row);
    if (filled === 0) {
      skipped.push({ row: r, reason: 'blank', detail: 'Empty row', preview: '' });
      continue;
    }
    if (row.map((c) => (isBlank(c) ? '' : String(c).trim().toLowerCase())).join('\u0001') === headerKey) {
      skipped.push({ row: r, reason: 'repeated-header', detail: 'Repeated header row', preview: preview(row) });
      continue;
    }
    const texts = row.filter(isText);
    const totalLabel = texts.find((t) => TOTAL_RE.test(t.trim()) || TOTAL_ANYWHERE_RE.test(t));
    if (totalLabel && !texts.some((t) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t.trim()))) {
      skipped.push({ row: r, reason: 'total', detail: `Totals row ("${totalLabel.trim().slice(0, 40)}")`, preview: preview(row) });
      continue;
    }
    if (filled === 1 && texts.length === 1 && headers.length >= 3) {
      // A lone label: a section heading if data follows, otherwise a note/footer.
      const next = grid.slice(r + 1).find((x) => nonEmpty(x) > 0);
      if (next && nonEmpty(next) >= Math.min(3, typicalFilled)) {
        section = texts[0].trim();
        skipped.push({ row: r, reason: 'section-heading', detail: `Section heading "${section.slice(0, 40)}"`, preview: preview(row) });
      } else {
        skipped.push({ row: r, reason: 'note', detail: 'Note or footer text', preview: preview(row) });
      }
      continue;
    }
    if (filled <= 2 && texts.length === filled && typicalFilled >= 4 && texts.some((t) => t.length > 25 || /^(\*|note|source|källa|anm|hinweis|quelle)/i.test(t))) {
      skipped.push({ row: r, reason: 'note', detail: 'Note or footer text', preview: preview(row) });
      continue;
    }
    candidates.push({ row: r, cells: columnIndex.map((c) => row[c]), section });
  }

  // 5. Totals without a label: rows with no text whose numbers equal the sum of the rows above.
  const rowsOut = removeComputedTotals(candidates, skipped, grid);
  skipped.sort((a, b) => a.row - b.row);
  return { headerRows, headers, columnIndex, rows: rowsOut, skipped, droppedColumns };
}

function medianFilled(rows: RawCell[][]): number {
  const counts = rows.map(nonEmpty).filter((n) => n > 0).sort((a, b) => a - b);
  return counts.length ? counts[Math.floor(counts.length / 2)] : 0;
}

function removeComputedTotals(rows: DataRow[], skipped: SkippedRow[], grid: RawCell[][]): DataRow[] {
  const out: DataRow[] = [];
  let groupStart = 0; // index in `out` where the current subtotal group starts
  for (const row of rows) {
    const hasText = row.cells.some(isText);
    const nums = row.cells.map((c) => (isBlank(c) ? undefined : parseNumber(c)?.value));
    const numericCols = nums.map((v, i) => (v !== undefined && v !== 0 ? i : -1)).filter((i) => i >= 0);
    if (!hasText && numericCols.length >= 1 && out.length - groupStart >= 2) {
      const sums = (from: number) =>
        numericCols.every((i) => {
          let s = 0;
          for (let k = from; k < out.length; k++) s += parseNumber(out[k].cells[i])?.value ?? 0;
          const v = nums[i]!;
          return Math.abs(s - v) <= Math.max(1e-6, Math.abs(v) * 0.005);
        });
      if (sums(groupStart) || sums(0)) {
        skipped.push({
          row: row.row,
          reason: 'computed-total',
          detail: 'Unlabelled row whose numbers equal the sum of the rows above',
          preview: preview(grid[row.row]),
        });
        groupStart = out.length;
        continue;
      }
    }
    out.push(row);
  }
  return out;
}
