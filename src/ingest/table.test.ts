import { describe, expect, it } from 'vitest';
import { detectTable } from './table.ts';
import { parseCsv, detectDelimiter, decodeText, readWorkbook } from './readFile.ts';
import * as XLSX from 'xlsx';
import type { RawCell } from './readFile.ts';

describe('CSV reading', () => {
  it('detects semicolon delimiter with decimal commas', () => {
    const text = 'ISIN;Namn;Marknadsvärde\nSE0000108656;Ericsson B;1 234,50\nSE0000115446;Volvo B;2 000,00\n';
    expect(detectDelimiter(text)).toBe(';');
  });
  it('handles quotes, escaped quotes and newlines in quotes', () => {
    expect(parseCsv('a,"b,c","d ""e""","f\ng"\n1,2,3,4', ',')).toEqual([
      ['a', 'b,c', 'd "e"', 'f\ng'],
      ['1', '2', '3', '4'],
    ]);
  });
  it('falls back to Windows-1252 for non-UTF-8 bytes', () => {
    const bytes = new Uint8Array([0x4d, 0xe4, 0x72, 0x6b]); // "Märk" in cp1252
    expect(decodeText(bytes)).toEqual({ text: 'Märk', encoding: 'Windows-1252' });
  });
  it('strips the UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(decodeText(bytes).text).toBe('A');
  });
});

describe('detectTable', () => {
  it('skips title rows, blanks, section headings, totals and notes', () => {
    const rows: RawCell[][] = [
      ['Holdings report', null, null, null],
      ['Fund: Example Fund', null, null, null],
      [null, null, null, null],
      ['ISIN', 'Name', 'Quantity', 'Market value'],
      ['Equities', null, null, null],
      ['SE0000108656', 'Ericsson B', 100, 1000],
      ['SE0000115446', 'Volvo B', 50, 2000],
      ['Subtotal equities', null, null, 3000],
      [null, null, null, null],
      ['Bonds', null, null, null],
      ['SE0004869071', 'SGB 1047', 10, 500],
      ['Total', null, null, 3500],
      [null, null, null, null],
      ['* Prices as of close of business. Source: custodian.', null, null, null],
    ];
    const t = detectTable(rows);
    expect(t.headerRows).toEqual([3]);
    expect(t.headers).toEqual(['ISIN', 'Name', 'Quantity', 'Market value']);
    expect(t.rows.map((r) => r.row)).toEqual([5, 6, 10]);
    expect(t.rows[0].section).toBe('Equities');
    expect(t.rows[2].section).toBe('Bonds');
    const reasons = Object.fromEntries(t.skipped.map((s) => [s.row, s.reason]));
    expect(reasons).toEqual({
      0: 'above-header',
      1: 'above-header',
      4: 'section-heading',
      7: 'total',
      8: 'blank',
      9: 'section-heading',
      11: 'total',
      12: 'blank',
      13: 'note',
    });
  });

  it('combines a two-row (merged) header', () => {
    const rows: RawCell[][] = [
      [null, null, 'Market value', 'Market value'],
      ['ISIN', 'Name', 'Local', 'SEK'],
      ['SE0000108656', 'Ericsson B', 1000, 1000],
      ['US0378331005', 'Apple', 100, 1050],
    ];
    const t = detectTable(rows);
    expect(t.headerRows).toEqual([0, 1]);
    expect(t.headers).toEqual(['ISIN', 'Name', 'Market value Local', 'Market value SEK']);
  });

  it('detects unlabelled total rows by their sums', () => {
    const rows: RawCell[][] = [
      ['ISIN', 'Name', 'Value'],
      ['SE0000108656', 'A', '1 000,50'],
      ['SE0000115446', 'B', '2 000,25'],
      [null, null, '3 000,75'],
    ];
    const t = detectTable(rows);
    expect(t.rows).toHaveLength(2);
    expect(t.skipped.find((s) => s.row === 3)?.reason).toBe('computed-total');
  });

  it('drops empty columns, names unnamed ones, de-duplicates headers', () => {
    const rows: RawCell[][] = [
      ['ISIN', null, 'Value', 'Value', null],
      ['SE0000108656', null, 1, 2, 'x'],
      ['SE0000115446', null, 3, 4, null],
    ];
    const t = detectTable(rows);
    expect(t.headers).toEqual(['ISIN', 'Value', 'Value (2)', 'Column 5']);
    expect(t.droppedColumns).toEqual([1]);
  });

  it('skips repeated header rows (page breaks)', () => {
    const rows: RawCell[][] = [
      ['ISIN', 'Name', 'Value'],
      ['SE0000108656', 'A', 1],
      ['ISIN', 'Name', 'Value'],
      ['SE0000115446', 'B', 2],
    ];
    const t = detectTable(rows);
    expect(t.rows).toHaveLength(2);
    expect(t.skipped[0].reason).toBe('repeated-header');
  });

  it('respects a forced header row', () => {
    const rows: RawCell[][] = [
      ['a', 'b', 'c'],
      ['x', 'y', 'z'],
      ['1', '2', '3'],
    ];
    expect(detectTable(rows, { headerRow: 1 }).headers).toEqual(['x', 'y', 'z']);
  });
});

describe('readWorkbook (xlsx round trip)', () => {
  it('reads values, dates and expands merged header cells', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Report'],
      [null, null, 'Marknadsvärde', null],
      ['ISIN', 'Förfallodag', 'Lokal', 'SEK'],
      ['SE0004869071', new Date(Date.UTC(2029, 10, 12)), 100.5, 100.5],
    ]);
    ws['!merges'] = [{ s: { r: 1, c: 2 }, e: { r: 1, c: 3 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Innehav');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const book = readWorkbook(bytes, 'test.xlsx');
    expect(book.kind).toBe('xlsx');
    const rows = book.sheets[0].rows;
    expect(rows[1][3]).toBe('Marknadsvärde');
    expect((rows[3][1] as Date).toISOString().slice(0, 10)).toBe('2029-11-12');
    const t = detectTable(rows);
    expect(t.headers).toEqual(['ISIN', 'Förfallodag', 'Marknadsvärde Lokal', 'Marknadsvärde SEK']);
  });
});
