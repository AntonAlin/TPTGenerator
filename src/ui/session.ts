/**
 * In-memory working state for one conversion session, plus helpers that
 * turn an uploaded file into a detected table and column predictions.
 */
import { readFile, type RawWorkbook } from '../ingest/readFile.ts';
import { detectTable, type DetectedTable } from '../ingest/table.ts';
import { classifyColumns, type ColumnPrediction, type MappingSource } from '../detect/classify.ts';
import type { CanonicalField } from '../detect/canonical.ts';
import type { ColumnInput } from '../detect/features.ts';
import { profileMapping, type SourceProfile } from '../profiles/profiles.ts';

export interface LoadedSheet {
  workbook: RawWorkbook;
  sheetName: string;
  table: DetectedTable;
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
      const table = detectTable(s.rows);
      const score = table.rows.length * table.headers.length;
      if (score > bestScore) {
        bestScore = score;
        best = { workbook, sheetName: s.name, table };
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
  return { workbook: current.workbook, sheetName, table: detectTable(sheet.rows, { headerRow }), headerRowOverride: headerRow };
}

export function columnsOf(table: DetectedTable): ColumnInput[] {
  return table.headers.map((header, i) => ({ header, values: table.rows.map((r) => r.cells[i]) }));
}

export function predict(table: DetectedTable, profile?: SourceProfile, userPins: Map<number, CanonicalField> = new Map()): ColumnPrediction[] {
  const fixed = new Map<number, { field: CanonicalField; source: MappingSource }>();
  if (profile) for (const [i, f] of profileMapping(profile, table.headers)) fixed.set(i, { field: f, source: 'profile' });
  for (const [i, f] of userPins) fixed.set(i, { field: f, source: 'user' });
  return classifyColumns(columnsOf(table), fixed);
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
