/**
 * In-memory working state for one conversion session, plus helpers that
 * turn an uploaded file into a detected table and column predictions.
 */
import { readFile, type RawWorkbook } from '../ingest/readFile.ts';
import { detectTable, type DetectedTable } from '../ingest/table.ts';
import { applySplit, withDefaultSplit, type SplitChoice } from '../ingest/split.ts';
import { parseDate } from '../ingest/values.ts';
import { classifyColumns, type ColumnPrediction, type MappingSource } from '../detect/classify.ts';
import type { CanonicalField } from '../detect/canonical.ts';
import type { ColumnInput } from '../detect/features.ts';
import { profileMapping, type SourceProfile } from '../profiles/profiles.ts';

export interface LoadedSheet {
  workbook: RawWorkbook;
  sheetName: string;
  /** The table the rest of the app works on: one portfolio on one date. */
  table: DetectedTable;
  /** The whole table before a multi-portfolio / multi-date file was cut (same as table otherwise). */
  fullTable: DetectedTable;
  /** Header row chosen by the user (0-based), undefined = auto. */
  headerRowOverride?: number;
}

export interface ColumnMapping {
  field: CanonicalField;
  source: MappingSource;
}

export async function loadFile(file: File): Promise<LoadedSheet> {
  const workbook = await readFile(file);
  if (!workbook.sheets.length) throw new Error('The file contains no sheets with data.');
  // Pick the sheet that yields the biggest table.
  let best: LoadedSheet | undefined;
  let bestScore = -1;
  for (const s of workbook.sheets) {
    try {
      const full = detectTable(s.rows);
      const score = full.rows.length * full.headers.length;
      if (score > bestScore) {
        bestScore = score;
        best = { workbook, sheetName: s.name, fullTable: full, table: withDefaultSplit(full) };
      }
    } catch {
      /* sheet without a table */
    }
  }
  if (!best) throw new Error('No table with a header row was found in this file.');
  return best;
}

export function reloadSheet(current: LoadedSheet, sheetName: string, headerRow?: number): LoadedSheet {
  const sheet = current.workbook.sheets.find((s) => s.name === sheetName);
  if (!sheet) throw new Error(`Sheet ${sheetName} not found.`);
  const full = detectTable(sheet.rows, { headerRow });
  return { workbook: current.workbook, sheetName, fullTable: full, table: withDefaultSplit(full), headerRowOverride: headerRow };
}

/** Convert another portfolio or date of a multi-portfolio / multi-date file. */
export function chooseSlice(current: LoadedSheet, choice: SplitChoice): LoadedSheet {
  const split = current.table.split;
  return split ? { ...current, table: applySplit(current.fullTable, split, choice) } : current;
}

export function columnsOf(table: DetectedTable): ColumnInput[] {
  return table.headers.map((header, i) => ({ header, values: table.rows.map((r) => r.cells[i]) }));
}

export function predict(table: DetectedTable, profile?: SourceProfile, userPins: Map<number, CanonicalField> = new Map()): ColumnPrediction[] {
  const fixed = new Map<number, { field: CanonicalField; source: MappingSource }>();
  if (profile) for (const [i, f] of profileMapping(profile, table.headers)) fixed.set(i, { field: f, source: 'profile' });
  for (const [i, f] of userPins) fixed.set(i, { field: f, source: 'user' });
  // The portfolio and as-of date columns pick the rows; they are not holding data.
  const picker = new Map<number, string>();
  if (table.split?.dateCol !== undefined) picker.set(table.split.dateCol, 'Holds each row\'s as-of date: used in the upload step to pick the date to convert');
  if (table.split?.portfolioCol !== undefined) picker.set(table.split.portfolioCol, 'Holds each row\'s portfolio: used in the upload step to pick the portfolio to convert');
  for (const i of picker.keys()) if (!fixed.has(i)) fixed.set(i, { field: 'ignore', source: 'model' });
  const preds = classifyColumns(columnsOf(table), fixed);
  for (const p of preds) if (picker.has(p.index) && p.source === 'model' && p.field === 'ignore') p.reasons = [picker.get(p.index)!];
  return preds;
}

/** Up to n distinct non-empty sample values of a column, as display strings. */
export function sampleValues(table: DetectedTable, col: number, n = 5): string[] {
  const out: string[] = [];
  for (const r of table.rows) {
    const v = r.cells[col];
    if (v == null || (typeof v === 'string' && !v.trim())) continue;
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    if (!out.includes(s)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

/** Trigger a browser download of in-memory data (no network involved). */
export function downloadBlob(data: BlobPart, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A date found in the title/metadata rows above the table (e.g. "Per: 2026-09-30"), as a valuation date suggestion. */
export function dateFromMetadata(table: DetectedTable): string | undefined {
  for (const s of table.skipped) {
    if (s.reason !== 'above-header') continue;
    const m = /(\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}[- ][A-Za-zé]{3,9}[- ]\d{4})/.exec(s.preview);
    const iso = m ? parseDate(m[1]) : undefined;
    if (iso) return iso;
  }
  return undefined;
}
