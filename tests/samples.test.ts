import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../src/ingest/readFile.ts';
import { detectTable } from '../src/ingest/table.ts';
import { classifyColumns } from '../src/detect/classify.ts';

function analyse(file: string) {
  const wb = readWorkbook(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../samples', file))), file);
  const t = detectTable(wb.sheets[0].rows);
  const preds = classifyColumns(t.headers.map((h, i) => ({ header: h, values: t.rows.map((r) => r.cells[i]) })));
  return { wb, t, map: Object.fromEntries(preds.map((p) => [p.header, p.field])) };
}

describe('sample files: table detection and column mapping', () => {
  it('se_custodian_holdings.xlsx (Swedish, merged two-row header, sections, subtotals, notes)', () => {
    const { t, map } = analyse('se_custodian_holdings.xlsx');
    expect(t.headerRows).toEqual([4, 5]);
    expect(t.rows).toHaveLength(7);
    expect(t.skipped.filter((s) => s.reason === 'total')).toHaveLength(3);
    expect(t.skipped.filter((s) => s.reason === 'section-heading')).toHaveLength(3);
    expect(map).toMatchObject({
      ISIN: 'isin',
      Värdepapper: 'security_name',
      Antal: 'quantity',
      Valuta: 'currency',
      Kurs: 'price',
      Förfallodag: 'maturity_date',
      'Marknadsvärde Lokal': 'market_value_local',
      'Marknadsvärde SEK': 'market_value_portfolio',
      'Andel %': 'weight',
      Kommentar: 'ignore',
    });
  });

  it('en_bond_portfolio.csv (English, quoted thousands, title rows, blank row, total)', () => {
    const { t, map } = analyse('en_bond_portfolio.csv');
    expect(t.rows).toHaveLength(4);
    expect(t.skipped.map((s) => s.reason)).toEqual(['above-header', 'above-header', 'blank', 'total']);
    expect(map).toMatchObject({
      ISIN: 'isin',
      'Security Description': 'security_name',
      'Par Value': 'nominal',
      'Clean Price': 'price',
      CCY: 'currency',
      Coupon: 'coupon',
      Maturity: 'maturity_date',
      'Market Value (Local)': 'market_value_local',
      'Accrued Interest': 'accrued_interest',
    });
  });

  it('se_fund_admin_semicolon.csv (Windows-1252, semicolons, decimal comma, unlabelled total)', () => {
    const { wb, t, map } = analyse('se_fund_admin_semicolon.csv');
    expect(wb.notes[0]).toMatch(/Windows-1252.*";"/);
    expect(t.rows).toHaveLength(5);
    expect(t.skipped.map((s) => s.reason)).toEqual(['computed-total']);
    expect(map).toMatchObject({
      Namn: 'security_name',
      'ISIN-kod': 'isin',
      Antal: 'quantity',
      Valuta: 'currency',
      'Marknadsvärde SEK': 'market_value_portfolio',
      'Andel av fondförmögenhet': 'weight',
    });
  });

  it('de_depot_statement.xlsx (German, repeated header after page break, Summe)', () => {
    const { t, map } = analyse('de_depot_statement.xlsx');
    expect(t.rows).toHaveLength(4);
    expect(t.skipped.map((s) => s.reason)).toEqual(['above-header', 'above-header', 'repeated-header', 'total']);
    expect(map).toMatchObject({
      ISIN: 'isin',
      Wertpapierbezeichnung: 'security_name',
      Währung: 'currency',
      Kurs: 'price',
      'Kurswert in EUR': 'market_value_portfolio',
      Stückzinsen: 'accrued_interest',
      Fälligkeit: 'maturity_date',
      Land: 'country',
    });
  });

  it('generic_headers.xlsx (no meaningful headers): identifiers found from values', () => {
    const { map } = analyse('generic_headers.xlsx');
    expect(map.Col1).toBe('isin');
    expect(map.Col3).toBe('currency');
  });
});
