import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import * as XLSX from 'xlsx';
import { readWorkbook } from '../ingest/readFile.ts';
import { detectTable } from '../ingest/table.ts';
import { classifyColumns } from '../detect/classify.ts';
import { normalizeHoldings } from '../derive/holdings.ts';
import { buildFxTable, impliedFxRates } from '../derive/valuation.ts';
import { DEFAULT_CONVENTIONS, resolveHoldings } from '../derive/resolve.ts';
import { emptyPortfolio, fundNav, type PortfolioState } from '../portfolio/portfolio.ts';
import { spec } from '../spec/index.ts';
import { buildTptFiles, cellValue } from './buildTpt.ts';
import { buildQualityReport, applies } from './quality.ts';
import { tptAoa, writeQualityXlsx, writeTptCsv, writeTptXlsx } from './write.ts';
import { field } from '../spec/index.ts';

function pipeline(p: PortfolioState) {
  const file = 'se_custodian_holdings.xlsx';
  const wb = readWorkbook(new Uint8Array(readFileSync(resolvePath(import.meta.dirname, '../../samples', file))), file);
  const t = detectTable(wb.sheets[0].rows);
  const mapping = classifyColumns(t.headers.map((h, i) => ({ header: h, values: t.rows.map((r) => r.cells[i]) }))).map((x) => x.field);
  const { holdings } = normalizeHoldings(t, mapping);
  const base = p.level === 'fund' ? p.values['4'] : p.baseCurrency;
  const ccys = [...holdings.map((h) => h.file.currency!), ...p.shareClasses.map((c) => c.values['4']).filter(Boolean)];
  const fx = buildFxTable(ccys, base, impliedFxRates(holdings), p.fxUser).table;
  const result = resolveHoldings(holdings, { ...DEFAULT_CONVENTIONS, valuationDate: p.values['6'], portfolioCurrency: base, fx, nav: fundNav(p, (c) => fx[c]?.rate).nav });
  return { result, fx, files: buildTptFiles(result, p, fx, { today: '2026-10-05', freeText: 'Exempel' }) };
}

const fundLevel = () => {
  const p = emptyPortfolio();
  p.values = { '1': 'SE0000108656', '3': 'Exempelfonden', '4': 'SEK', '5': '50241000', '6': '2026-09-30', '8': '125.3', '8b': '400966' };
  return p;
};

describe('buildTptFiles (fund level)', () => {
  const { files } = pipeline(fundLevel());
  const f = files[0];
  const col = (id: string) => spec.fields.findIndex((x) => x.id === id);

  it('uses the exact spec column order and headers', () => {
    const aoa = tptAoa(f);
    expect(aoa[0]).toEqual(spec.fields.map((x) => x.header));
    expect(aoa[0][0]).toBe('1_Portfolio_identifying_data');
    expect(aoa[0].at(-1)).toBe('1000_TPT_Version');
    expect(aoa).toHaveLength(1 + 7);
    expect(aoa.every((r) => r.length === spec.fields.length)).toBe(true);
  });
  it('names the file per the template convention', () => {
    expect(f.fileName).toBe('20260930_TPTV8_SE0000108656_20261005_Exempel');
  });
  it('fills portfolio, version, holding and exposure fields; leaves SCR and must-be-empty fields blank', () => {
    const r = f.rows[0];
    expect(r[col('1000')].value).toBe('V8.0 dated 8 October 2026');
    expect(r[col('2')].value).toBe('1');
    expect(r[col('11')].value).toBe('N');
    expect(r[col('5')]).toMatchObject({ value: '50241000', source: 'user' });
    expect(r[col('12')].value).toBe('SE31');
    expect(r[col('22')].value).toBe(10250400);
    expect(r[col('27')]).toMatchObject({ value: 10250400, source: 'derived' });
    expect(r[col('30')].value).toBeCloseTo(0.204, 6);
    for (const id of ['97', '98', '105a', '105b']) expect(r[col(id)]).toMatchObject({ source: 'missing' });
    for (const id of spec.fields.filter((x) => x.mustBeEmpty).map((x) => x.id)) expect(r[col(id)].value).toBeUndefined();
  });
  it('serialises numbers as numbers and codes as text', () => {
    expect(cellValue(field('5'), f.rows[0][col('5')])).toBe(50241000);
    expect(cellValue(field('2'), f.rows[0][col('2')])).toBe('1');
  });
  it('writes CSV and xlsx that read back', () => {
    const csv = writeTptCsv(f);
    expect(csv.startsWith('﻿1_Portfolio_identifying_data,')).toBe(true);
    expect(csv.split('\r\n')[1]).toContain('V8.0 dated 8 October 2026');
    const wb = XLSX.read(writeTptXlsx(f, true), { type: 'array' });
    expect(wb.SheetNames).toEqual(['TPT', 'Source', 'Source notes']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.TPT, { header: 1 });
    expect(rows[0]).toEqual(spec.fields.map((x) => x.header));
    const src = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Source, { header: 1 });
    expect(src[1][col('12')]).toMatch(/^derived \(low\) #\d+$/);
    expect(src[1][col('22')]).toBe('file');
    const notes = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Source notes'], { header: 1 });
    const ref = String(src[1][col('12')]).split(' ').pop();
    expect(notes.find((n) => n[0] === ref)?.[1]).toMatch(/Built from asset class "Equity"/);
  });
});

describe('share class level', () => {
  it('produces one file per class and converts portfolio-currency amounts', () => {
    const p = fundLevel();
    p.level = 'share_class';
    p.baseCurrency = 'SEK';
    p.shareClasses = [
      { values: { '1': 'SE0000108656', '3': 'A SEK', '4': 'SEK', '5': '40000000' } },
      { values: { '1': 'SE0000115446', '3': 'B EUR', '4': 'EUR', '5': '900000' } },
    ];
    const { files } = pipeline(p);
    expect(files).toHaveLength(2);
    const c24 = spec.fields.findIndex((x) => x.id === '24');
    const c4 = spec.fields.findIndex((x) => x.id === '4');
    expect(files[0].rows[0][c24].value).toBe(10250400);
    expect(files[1].rows[0][c4].value).toBe('EUR');
    expect(files[1].rows[0][c24].value).toBeCloseTo(10250400 / 11.5, 1);
    expect(files[1].rows[0][c24].method).toMatch(/converted from SEK to share class currency EUR/);
    expect(files[1].fileName).toContain('SE0000115446');
  });
});

describe('quality report', () => {
  const { files } = pipeline(fundLevel());
  const q = buildQualityReport(files[0]);
  it('summarises completeness by source', () => {
    expect(q.holdings).toBe(7);
    expect(q.summary.mandatoryFilled).toBeLessThan(q.summary.mandatoryCells);
    expect(q.summary.bySource.file).toBeGreaterThan(0);
    expect(q.summary.bySource.derived).toBeGreaterThan(0);
    const f12 = q.fields.find((x) => x.id === '12')!;
    expect(f12.counts.derived).toBe(7);
    expect(f12.pctFilled).toBe(1);
  });
  it('lists missing mandatory fields per holding and portfolio fields once', () => {
    expect(q.missingMandatory.some((m) => m.fieldId === '47' && m.identifier === 'SE0000108656')).toBe(true);
    expect(q.missingMandatory.filter((m) => m.fieldId === '115')).toHaveLength(1);
    expect(q.missingMandatory.find((m) => m.fieldId === '115')?.identifier).toBe('(portfolio)');
  });
  it('lists estimated values with methods', () => {
    const e = q.estimated.find((x) => x.fieldId === '90');
    expect(e?.method).toMatch(/ACT\/ACT ICMA/);
  });
  it('reports SCR fields as not derivable and validates weights', () => {
    expect(q.notDerived.find((n) => n.fieldId === '97')?.reason).toMatch(/SCR/);
    expect(q.validation.some((v) => v.fieldId === '26')).toBe(false);
    expect(q.summary.errors).toBe(0);
  });
  it('writes the report workbook', () => {
    const wb = XLSX.read(writeQualityXlsx(q), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Summary', 'Field completeness', 'Missing mandatory', 'Estimated values', 'Validation', 'Not derivable', 'Amount interpretation']);
  });
  it('applicability follows the CIC columns', () => {
    expect(applies(field('33'), 'SE31')).toBe(false);
    expect(applies(field('33'), 'SE11')).toBe(true);
    expect(applies(field('1'), 'SE31')).toBe(true);
  });
});

describe('quality report validation', () => {
  it('flags invalid ISINs, weights not summing to 100% and bad codes', () => {
    const p = fundLevel();
    const holdings = [
      { index: 0, row: 1, unparsed: {}, file: { isin: 'US0378331006', security_name: 'Bad ISIN Inc', currency: 'SEK', market_value_local: 100, weight: 0.4, country: 'SE' } },
      { index: 1, row: 2, unparsed: {}, file: { isin: 'SE0000108656', security_name: 'Ericsson B', currency: 'SEK', market_value_local: 100, weight: 0.4, cic: 'SE35' } },
    ];
    const result = resolveHoldings(holdings, { ...DEFAULT_CONVENTIONS, valuationDate: '2026-09-30', portfolioCurrency: 'SEK', fx: {}, nav: 250 });
    const q = buildQualityReport(buildTptFiles(result, p, {}, { today: '2026-10-05' })[0]);
    const msgs = q.validation.map((v) => v.message).join('\n');
    expect(msgs).toMatch(/US0378331006.*not a valid ISIN/);
    expect(msgs).toMatch(/CIC "SE35" in the file is not valid/);
    expect(msgs).toMatch(/weights sum to 80.00%/);
    expect(q.summary.errors).toBeGreaterThanOrEqual(2);
  });
});
