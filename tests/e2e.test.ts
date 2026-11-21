/**
 * End-to-end tests: every sample file goes through the complete pipeline
 * (read → table detection → column classification → derivations → TPT →
 * quality report → xlsx/csv) and the written TPT is read back and checked
 * the way a recipient would see it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { spec, field } from '../src/spec/index.ts';
import { validateFieldValue } from '../src/spec/validate.ts';
import { SecurityMaster } from '../src/master/securityMaster.ts';
import { MemoryStore } from '../src/profiles/store.ts';
import { col, roundTripXlsx, runPipeline, SAMPLES, writeQualityXlsx, writeTptCsv } from './pipeline.ts';

const SCR_IDS = spec.fields.filter((f) => /SCR/i.test(f.section)).map((f) => f.id);
const EMPTY_IDS = spec.fields.filter((f) => f.mustBeEmpty).map((f) => f.id);

interface Case {
  file: string;
  holdings: number;
  options?: Parameters<typeof runPipeline>[1];
}

const CASES: Case[] = [
  { file: 'se_custodian_holdings.xlsx', holdings: 7 },
  { file: 'en_bond_portfolio.csv', holdings: 4, options: { portfolio: (p) => (p.values['4'] = 'USD'), fxUser: { EUR: 1.08 } } },
  { file: 'se_fund_admin_semicolon.csv', holdings: 5 },
  { file: 'de_depot_statement.xlsx', holdings: 4 },
  { file: 'fr_portefeuille.csv', holdings: 5 },
  { file: 'en_multi_asset.xls', holdings: 10 },
  { file: 'en_custodian_mixed_amounts.xlsx', holdings: 8 },
  { file: 'sv_nominellt_eller_varde.csv', holdings: 5, options: { portfolio: (p) => (p.values['4'] = 'SEK') } },
  {
    file: 'generic_headers.xlsx',
    holdings: 3,
    options: { mapping: { Col4: 'quantity', Col5: 'market_value_local' }, portfolio: (p) => (p.values['4'] = 'SEK'), fxUser: { USD: 10.4 } },
  },
];

it('covers every file in /samples', () => {
  expect(readdirSync(SAMPLES).sort()).toEqual(CASES.map((c) => c.file).sort());
});

/** A market value in the file turned out to be something else (e.g. a forward's notional) and was dropped. */
const valueDropped = (r: ReturnType<typeof runPipeline>['result']['rows'][number]) =>
  !!r.holding.amounts?.cells.some((c) => (c.cell.field === 'market_value_local' || c.cell.field === 'market_value_portfolio') && c.role !== 'mv_local' && c.role !== 'mv_port');

describe.each(CASES)('$file', ({ file, holdings, options }) => {
  const run = runPipeline(file, options);
  const tptFile = run.files[0];
  const report = run.reports[0];
  const { wb, tpt } = roundTripXlsx(tptFile);
  const dropped = run.result.rows.filter(valueDropped).length;

  it('writes a TPT with the exact spec headers, one row per holding', () => {
    expect(tpt[0]).toEqual(spec.fields.map((f) => f.header));
    expect(tpt).toHaveLength(1 + holdings);
    for (const row of tpt) expect(row).toHaveLength(spec.fields.length);
    expect(wb.SheetNames).toEqual(['TPT', 'Source', 'Source notes']);
  });

  it('fills the version field and leaves SCR and no-longer-maintained fields empty', () => {
    for (const row of tpt.slice(1)) {
      expect(row[col('1000')]).toBe(spec.meta.versionFieldValue);
      for (const id of [...SCR_IDS, ...EMPTY_IDS]) expect(row[col(id)], `field ${id}`).toBeNull();
      expect(row[col('11')]).toBe('N');
    }
  });

  it('every written value passes the spec validation and the report has no errors', () => {
    for (const row of tpt.slice(1)) {
      row.forEach((v, j) => {
        if (v !== null) expect(validateFieldValue(spec.fields[j], v), `${spec.fields[j].header} = ${v}`).toBeUndefined();
      });
    }
    expect(report.summary.errors).toBe(0);
    const weightIssues = report.validation.filter((v) => v.fieldId === '26').map((v) => v.message);
    expect(weightIssues).toEqual(dropped ? [`${dropped} holding(s) have no valuation weight.`] : []);
  });

  it('keeps input values and identifiers, and every holding gets a valid CIC and a market value', () => {
    run.result.rows.forEach((r, i) => {
      const row = tpt[i + 1];
      if (r.holding.file.isin) expect(row[col('14')]).toBe(r.holding.file.isin);
      expect(String(row[col('12')])).toMatch(/^[A-Z]{2}[0-9A-F]\d$/);
      if (valueDropped(r)) {
        expect(row[col('24')]).toBeNull();
        return;
      }
      expect(typeof row[col('24')]).toBe('number');
      expect(typeof row[col('26')]).toBe('number');
    });
  });

  it('weights sum to 100%', () => {
    const sum = tpt.slice(1).reduce((a, r) => a + ((r[col('26')] as number | null) ?? 0), 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  it('records the origin of every value in the Source sheet', () => {
    const src = XLSX.utils.sheet_to_json<(string | null)[]>(wb.Sheets.Source, { header: 1, defval: null });
    for (let i = 1; i < src.length; i++) {
      src[i].forEach((s, j) => {
        const v = tpt[i][j];
        if (v === null) expect(s).toBeNull();
        else expect(s).toMatch(/^(file|master|user|derived \((high|medium|low)\))( #\d+)?$/);
      });
    }
  });

  it('writes CSV and the quality report', () => {
    const csv = writeTptCsv(tptFile).replace(/^﻿/, '');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + holdings);
    expect(XLSX.read(writeQualityXlsx(report), { type: 'array' }).SheetNames).toHaveLength(7);
    expect(report.notDerived.map((n) => n.fieldId)).toEqual(expect.arrayContaining(['97', '105b']));
  });
});

describe('sample-specific results', () => {
  const rowOf = (run: ReturnType<typeof runPipeline>, name: RegExp) => {
    const i = run.result.rows.findIndex((r) => name.test(String(r.attrs.name.value)));
    expect(i, `holding ${name}`).toBeGreaterThanOrEqual(0);
    return run.files[0].rows[i];
  };

  it('Swedish custodian: government bond analytics, FX-converted equity, cash XT71', () => {
    const run = runPipeline('se_custodian_holdings.xlsx');
    expect(run.portfolio.values['4']).toBe('SEK');
    const sgb = rowOf(run, /^SWEDEN/);
    expect(sgb[col('12')].value).toBe('SE11');
    expect(sgb[col('90')].value).toBeCloseTo(2.989371, 5);
    expect(sgb[col('22')].value).toBeCloseTo(9478664.38, 1);
    expect(rowOf(run, /Apple/)[col('24')].value).toBe(7129200);
    expect(rowOf(run, /Likvida/)[col('12')].value).toBe('XT71');
  });

  it('English bonds: user FX rate converts EUR bonds into the USD portfolio currency', () => {
    const run = runPipeline('en_bond_portfolio.csv', { portfolio: (p) => (p.values['4'] = 'USD'), fxUser: { EUR: 1.08 } });
    const oat = rowOf(run, /OAT/);
    expect(oat[col('24')].value).toBeCloseTo((oat[col('22')].value as number) * 1.08, 0);
    expect(oat[col('12')].value).toBe('FR11');
    expect(rowOf(run, /UST/)[col('33')].value).toBeCloseTo(4.125);
  });

  it('German depot: accrued interest from the file, fund recognised from "Rentenfonds"', () => {
    const run = runPipeline('de_depot_statement.xlsx');
    const bund = rowOf(run, /Bundesrep/);
    expect(bund[col('22')]).toMatchObject({ value: 1938095.89 });
    expect(bund[col('39')]).toMatchObject({ value: '2032-08-15', source: 'file' });
    expect(rowOf(run, /Rentenfonds/)[col('12')].value).toBe('XL42');
  });

  it('French portfolio: money market fund, OAT coupon from the name, comment column ignored', () => {
    const run = runPipeline('fr_portefeuille.csv');
    expect(run.mapping[run.table.headers.indexOf('Commentaire')]).toBe('ignore');
    expect(rowOf(run, /MONETAIRE/)[col('12')].value).toBe('XL43');
    const oat = rowOf(run, /OAT/);
    expect(oat[col('33')]).toMatchObject({ value: 2.75, source: 'derived' });
    expect(oat[col('22')].value).toBeCloseTo(1029150.68, 2);
  });

  it('Multi-asset .xls: file CICs, LEIs, FX forward exposure = notional, future exposure left blank', () => {
    const run = runPipeline('en_multi_asset.xls');
    const covered = rowOf(run, /COVERED/);
    expect(covered[col('12')]).toMatchObject({ value: 'XL27', source: 'file' });
    expect(covered[col('48')].value).toBe('1');
    const fwd = rowOf(run, /FX FWD/);
    expect(fwd[col('12')].value).toBe('XTE2');
    expect(fwd[col('19')].value).toBe(5000000);
    expect(fwd[col('27')].value).toBe(5000000);
    expect(fwd[col('28')].value).toBeCloseTo(5000000 / 1.1, 0);
    expect(fwd[col('14')].value).toBe('FWD-0001');
    expect(fwd[col('15')].source).toBe('missing');
    const fut = rowOf(run, /STOXX/);
    expect(fut[col('12')].value).toBe('XLA1');
    expect(fut[col('27')].source).toBe('missing');
    expect(fut[col('27')].note).toMatch(/delta|underlying/);
    expect(rowOf(run, /ETF/)[col('12')].value).toBe('IE41');
  });

  it('share class level: one file per class, amounts converted to the class currency', () => {
    const run = runPipeline('se_fund_admin_semicolon.csv', {
      fxUser: { EUR: 11.5 },
      portfolio: (p) => {
        p.level = 'share_class';
        p.baseCurrency = 'SEK';
        p.shareClasses = [
          { values: { '1': 'SE0000108656', '3': 'Class A SEK', '4': 'SEK', '5': '30000000' } },
          { values: { '1': 'SE0000115446', '3': 'Class B EUR', '4': 'EUR', '5': '150000' } },
        ];
      },
    });
    expect(run.files.map((f) => f.portfolioCurrency)).toEqual(['SEK', 'EUR']);
    const [a, b] = run.files;
    expect(a.fileName).not.toBe(b.fileName);
    expect(b.rows[1][col('24')].value).toBeCloseTo(11050000 / 11.5, 1);
    expect(b.rows[1][col('4')].value).toBe('EUR');
    expect(b.rows[1][col('26')].value).toBe(a.rows[1][col('26')].value);
  });

  it('security master values flow into the TPT and the Source sheet', async () => {
    const master = await SecurityMaster.open(new MemoryStore());
    await master.set('identifier', 'name:LIKVIDA MEDEL SEK', 'Likvida medel SEK', 'CASH-SEK-01');
    await master.set('id_type', 'name:LIKVIDA MEDEL SEK', 'Likvida medel SEK', '99');
    await master.set('issuer_name', 'isin:SE0000108656', 'Ericsson B', 'Telefonaktiebolaget LM Ericsson');
    await master.set('nace', 'name:TELEFONAKTIEBOLAGET LM ERICSSON', 'LM Ericsson', 'C2630');
    const run = runPipeline('se_custodian_holdings.xlsx', { master });
    const cash = rowOf(run, /Likvida/);
    expect(cash[col('14')]).toMatchObject({ value: 'CASH-SEK-01', source: 'master' });
    expect(cash[col('15')].value).toBe('99');
    const eric = rowOf(run, /Ericsson/);
    expect(eric[col('148')]).toMatchObject({ value: 'C2630', source: 'master' });
    const { wb } = roundTripXlsx(run.files[0]);
    const src = XLSX.utils.sheet_to_json<(string | null)[]>(wb.Sheets.Source, { header: 1, defval: null });
    expect(src[1][col('148')]).toMatch(/^master/);
    expect(run.reports[0].missingMandatory.some((m) => m.fieldId === '14' && /Likvida/.test(m.name))).toBe(false);
  });

  it('mixed "Holding" column and a forward notional shown as market value', () => {
    const run = runPipeline('en_custodian_mixed_amounts.xlsx');
    expect(['amount_mixed', 'quantity']).toContain(run.mapping[run.table.headers.indexOf('Holding')]);
    expect(run.mapping[run.table.headers.indexOf('Market value')]).toBe('market_value_local');
    const sap = rowOf(run, /^SAP/);
    expect(sap[col('18')].value).toBe(4000);
    expect(sap[col('19')].source).toBe('missing');
    const bund = rowOf(run, /BUND/);
    expect(bund[col('19')].value).toBe(1_000_000);
    expect(bund[col('18')].source).toBe('missing');
    expect(bund[col('23')].value).toBe(989_000);
    const fwd = rowOf(run, /FX FWD/);
    expect(fwd[col('19')].value).toBe(2_000_000);
    expect(fwd[col('22')].source).toBe('missing');
    expect(fwd[col('24')].source).toBe('missing');
    expect(fwd[col('27')].value).toBe(2_000_000);
    expect(rowOf(run, /STOXX/)[col('18')].value).toBe(10);
    expect(rowOf(run, /CASH EUR/)[col('22')].value).toBe(250_000);
    expect(run.amounts.notes.join(' ')).toMatch(/Market value \(EUR\)": total .* matches after re-reading 1 cell/);
    const fwdReport = run.reports[0].amounts.find((a) => /FX FWD/.test(a.name));
    expect(fwdReport?.evidence).toMatch(/reported total/);
  });

  it('"Nominellt/Marknadsvärde": nominal for bonds, market value for the rest, decided by the weights', () => {
    const run = runPipeline('sv_nominellt_eller_varde.csv', { portfolio: (p) => (p.values['4'] = 'SEK') });
    expect(run.mapping[run.table.headers.indexOf('Nominellt/Marknadsvärde')]).toBe('amount_mixed');
    expect(run.norm.notes.join(' ')).toMatch(/"Kurs": values like "85,420" are ambiguous/);
    const eric = rowOf(run, /Ericsson/);
    expect(eric[col('22')]).toMatchObject({ value: 855_000, source: 'file' });
    expect(eric[col('22')].method).toMatch(/read as market value/);
    expect(eric[col('24')].value).toBe(855_000);
    expect(eric[col('18')].source).toBe('missing');
    const sgb = rowOf(run, /^SWEDEN/);
    expect(sgb[col('19')].value).toBe(5_000_000);
    expect(sgb[col('25')].value).toBe(4_706_250);
    expect(Math.abs(run.amounts.navEstimate! / 10_000_450 - 1)).toBeLessThan(0.0001);
    for (const i of [0, 1, 2, 3]) expect(run.amounts.interpretations[i]!.confidence).not.toBe('low');
  });

  it('field 148 in the export is validated against the NACE list', () => {
    expect(validateFieldValue(field('148'), 'C2630')).toBeUndefined();
  });
});
