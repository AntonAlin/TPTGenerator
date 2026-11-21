/**
 * Read xlsx / xls / csv files into plain grids of raw cell values.
 * Runs entirely in the browser (or Node for tests). No data leaves the process.
 */
import * as XLSX from 'xlsx';

export type RawCell = string | number | boolean | Date | null;

export interface RawSheet {
  name: string;
  rows: RawCell[][];
}

export interface RawWorkbook {
  fileName: string;
  kind: 'xlsx' | 'xls' | 'csv' | 'other';
  sheets: RawSheet[];
  /** Notes about how the file was read (encoding, delimiter, …). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Decode bytes as UTF-8, falling back to Windows-1252 (common for Nordic/European Excel exports). */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE' };
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
    return { text, encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}

const DELIMITERS = [';', ',', '\t', '|'] as const;

/** Pick the delimiter that gives the most consistent, widest column count over the first lines. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 50);
  let best: string = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => splitCsvLine(l, d).length);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, modeCount] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (mode < 2) continue;
    const score = modeCount * Math.log2(mode + 1);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  return parseCsv(line, delimiter)[0] ?? [];
}

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsv(bytes: Uint8Array, fileName: string): RawWorkbook {
  const { text, encoding } = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter).map((r) => r.map((c): RawCell => (c.trim() === '' ? null : c.trim())));
  const delimName = delimiter === '\t' ? 'tab' : `"${delimiter}"`;
  return {
    fileName,
    kind: 'csv',
    sheets: [{ name: fileName.replace(/\.[^.]+$/, ''), rows }],
    notes: [`Read as CSV, encoding ${encoding}, delimiter ${delimName}.`],
  };
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export function readWorkbook(bytes: Uint8Array, fileName: string): RawWorkbook {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return readCsv(bytes, fileName);

  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, UTC: true, dense: false });
  const sheets: RawSheet[] = [];
  const notes: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws?.['!ref']) continue;
    if ((ws as { '!type'?: string })['!type'] === 'chart') continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows: RawCell[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: RawCell[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
        row.push(cellValue(cell));
      }
      rows.push(row);
    }
    // Propagate merged cell values so multi-column header labels apply to every column they span.
    const merges = ws['!merges'] ?? [];
    for (const m of merges) {
      const v = rows[m.s.r - range.s.r]?.[m.s.c - range.s.c] ?? null;
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          const rr = r - range.s.r;
          const cc = c - range.s.c;
          if (rows[rr] && rows[rr][cc] == null) rows[rr][cc] = v;
        }
      }
    }
    if (merges.length) notes.push(`Sheet "${name}": ${merges.length} merged cell range(s) expanded.`);
    sheets.push({ name, rows });
  }
  return { fileName, kind: ext === 'xls' ? 'xls' : ext === 'xlsx' || ext === 'xlsm' ? 'xlsx' : 'other', sheets, notes };
}

function cellValue(cell: XLSX.CellObject | undefined): RawCell {
  if (!cell || cell.v == null) return null;
  if (cell.t === 'e') return null;
  if (cell.v instanceof Date) return cell.v;
  if (typeof cell.v === 'string') {
    const t = cell.v.trim();
    return t === '' ? null : t;
  }
  return cell.v as number | boolean;
}

/** Convenience for the browser: read a File object. */
export async function readFile(file: File): Promise<RawWorkbook> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readWorkbook(bytes, file.name);
}
