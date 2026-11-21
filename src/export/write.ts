/**
 * Serialise TPT files and quality reports to xlsx / csv (in memory, for download).
 */
import * as XLSX from 'xlsx';
import { cellValue, sourceText, type TptFile } from './buildTpt.ts';
import type { QualityReport } from './quality.ts';
import { spec } from '../spec/index.ts';

type Aoa = (string | number | undefined)[][];

export function tptAoa(file: TptFile): Aoa {
  return [file.fields.map((f) => f.header), ...file.rows.map((row) => row.map((c, j) => cellValue(file.fields[j], c)))];
}

export function sourceAoa(file: TptFile): Aoa {
  return [file.fields.map((f) => f.header), ...file.rows.map((row) => row.map((c) => sourceText(c)))];
}

function sheet(aoa: Aoa, widths?: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((v) => (v === undefined ? null : v))));
  if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
  return ws;
}

/** TPT workbook: sheet "TPT" (first line = column names only, as the template requires), optional "Source" sheet. */
export function writeTptXlsx(file: TptFile, includeSource: boolean): Uint8Array<ArrayBuffer> {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(tptAoa(file)), 'TPT');
  if (includeSource) XLSX.utils.book_append_sheet(wb, sheet(sourceAoa(file)), 'Source');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

const csvEscape = (v: string | number | undefined, delimiter: string) => {
  if (v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : v;
  return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with decimal point, no thousands separators, ISO dates. UTF-8 with BOM so Excel reads accents correctly. */
export function writeTptCsv(file: TptFile, delimiter = ','): string {
  return `﻿${tptAoa(file)
    .map((r) => r.map((v) => csvEscape(v, delimiter)).join(delimiter))
    .join('\r\n')}\r\n`;
}

export function writeQualityXlsx(r: QualityReport): Uint8Array<ArrayBuffer> {
  const wb = XLSX.utils.book_new();
  const s = r.summary;
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–');
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      [
        ['TPT quality report'],
        ['File', r.fileName],
        ['Template', `${spec.meta.version} (${spec.meta.sourceFile.split('#')[0]})`],
        ['Holdings', r.holdings],
        ['Mandatory cells filled', `${s.mandatoryFilled} / ${s.mandatoryCells}`, pct(s.mandatoryFilled, s.mandatoryCells)],
        ['All applicable cells filled', `${s.filledCells} / ${s.applicableCells}`, pct(s.filledCells, s.applicableCells)],
        ['From file', s.bySource.file],
        ['From security master', s.bySource.master],
        ['Entered by user', s.bySource.user],
        ['Derived (estimated)', s.bySource.derived],
        ['Missing', s.bySource.missing],
        ['Validation errors', s.errors],
        ['Validation warnings', s.warnings],
        [],
        ['No market or reference data was used. Derived values are estimates; see the "Estimated values" sheet for the method of each.'],
      ],
      [32, 50, 12],
    ),
    'Summary',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      [
        ['Field', 'Header', 'Requirement', 'Applicable rows', 'Filled %', 'File', 'Master', 'User', 'Derived', 'Missing', 'Note'],
        ...r.fields.map((f) => [f.id, f.header, f.requirementRaw, f.applicable, f.applicable ? Math.round(f.pctFilled * 1000) / 10 : undefined, f.counts.file, f.counts.master, f.counts.user, f.counts.derived, f.counts.missing, f.mustBeEmpty ? 'Must be empty (no longer maintained)' : undefined]),
      ],
      [7, 60, 11, 10, 9, 7, 7, 7, 8, 8, 34],
    ),
    'Field completeness',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet([['Row', 'Identifier', 'Name', 'Field', 'Header', 'Why missing'], ...r.missingMandatory.map((m) => [m.row || undefined, m.identifier, m.name, m.fieldId, m.header, m.note])], [6, 16, 30, 7, 50, 70]),
    'Missing mandatory',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      [['Row', 'Identifier', 'Name', 'Field', 'Header', 'Value', 'Confidence', 'Method', 'Note'], ...r.estimated.map((e) => [e.row || undefined, e.identifier, e.name, e.fieldId, e.header, e.value, e.confidence, e.method, e.note])],
      [6, 16, 30, 7, 45, 16, 10, 80, 60],
    ),
    'Estimated values',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet([['Severity', 'Row', 'Identifier', 'Field', 'Message'], ...r.validation.map((v) => [v.severity, v.row, v.identifier, v.fieldId, v.message])], [9, 6, 16, 7, 100]),
    'Validation',
  );
  XLSX.utils.book_append_sheet(wb, sheet([['Field', 'Header', 'Why left blank'], ...r.notDerived.map((n) => [n.fieldId, n.header, n.reason])], [7, 60, 90]), 'Not derivable');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
