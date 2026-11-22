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
import { col, roundTripXlsx, runPipeline, SAMPLES, writeQualityXlsx, writeTptCsv } from './pipeline.ts';
import type { PortfolioState } from '../src/portfolio/portfolio.ts';

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

/** Samples with a block of their own below (they do not fit the generic checks). */
const DEDICATED = ['nexus_holdings_demo.csv'];

it('covers every file in /samples', () => {
  expect(readdirSync(SAMPLES).sort()).toEqual([...CASES.map((c) => c.file), ...DEDICATED].sort());
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
        else expect(s).toMatch(/^(file|user|derived \((high|medium|low)\))( #\d+)?$/);
      });
    }
  });

  it('writes CSV and the quality report', () => {
    const csv = writeTptCsv(tptFile).replace(/^﻿/, '');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + holdings);
    expect(XLSX.read(writeQualityXlsx(report), { type: 'array' }).SheetNames).toEqual(['Summary', 'Field completeness', 'Missing mandatory', 'Estimated values', 'Validation', 'Not derivable', 'Amount interpretation', 'Reconciliation']);
    expect(report.notDerived.map((n) => n.fieldId)).toEqual(expect.arrayContaining(['97', '105b']));
  });

  it('reconciles with the file: no total, weight, FX or row check fails, no row flagged', () => {
    expect(run.recon.checks.filter((c) => c.status === 'warn').map((c) => `${c.label}: ${c.detail}`)).toEqual([]);
    expect(run.recon.flags).toEqual([]);
  });
});

describe('sample-specific results', () => {
  const rowOf = (run: ReturnType<typeof runPipeline>, name: RegExp) => {
    const i = run.result.rows.findIndex((r) => name.test(String(r.attrs.name.value)));
    expect(i, `holding ${name}`).toBeGreaterThanOrEqual(0);
    return run.files[0].rows[i];
  };

  it('reconciliation: every sub-total and total of the Swedish custody report, and a notional printed as a value explained', () => {
    const se = runPipeline('se_custodian_holdings.xlsx').recon;
    expect(se.checks.filter((c) => c.kind === 'subtotal').map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(se.checks.filter((c) => c.kind === 'total').every((c) => c.status === 'ok')).toBe(true);
    const mixed = runPipeline('en_custodian_mixed_amounts.xlsx').recon.checks.find((c) => c.kind === 'total')!;
    expect(mixed.status).toBe('ok');
    expect(mixed.detail).toMatch(/As converted, the 8 row\(s\) add up to the file's total\. As shown they add up to .*: 1 cell\(s\) hold a notional printed in a value column/);
  });

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
    // The forward repeats its holding figure in both value columns; the total row agrees.
    expect(run.amounts.notes.join(' ')).toMatch(/Market value \(EUR\)": the market values add up to the reported total/);
    const fwdReport = run.reports[0].amounts.find((a) => /FX FWD/.test(a.name));
    expect(fwdReport?.evidence).toMatch(/reported total|repeats the notional/);
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

// The demo file of Nexus Portfolio Lab (made by its js/demofile.js): two funds on six month-ends in
// one table, 59 columns, no market value column (Nexus values holdings itself), and options, swaps,
// CDS and FX forwards that only a pricing model can value. Those get no market value here: the TPT
// leaves them blank and flagged rather than guessed.
describe('nexus_holdings_demo.csv (two funds on six dates, Nexus Portfolio Lab layout)', () => {
  const fxUser = { USD: 10.75, EUR: 11.0, NOK: 0.9, DKK: 1.47, CHF: 12.1 };
  const sek = (p: PortfolioState) => {
    p.values['4'] = 'SEK';
  };
  const run = runPipeline('nexus_holdings_demo.csv', { portfolio: sek, fxUser });
  const { tpt } = roundTripXlsx(run.files[0]);
  const byName = (name: string) => tpt.find((r) => r[col('17')] === name)!;
  const mapped = Object.fromEntries(run.predictions.map((p) => [p.header, p.field]));

  it('cuts the file to the first fund on its latest date, and can convert any other pair', () => {
    const s = run.table.split!;
    expect(s.portfolios).toEqual(['Demo: Nordic Balanced Fund', 'Demo: Nordic Equity Fund']);
    expect(s.dates).toEqual(['2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-30']);
    expect(s.choice).toEqual({ portfolio: 'Demo: Nordic Balanced Fund', date: '2026-10-30' });
    expect(s.rowsInFile).toBe(406);
    expect(tpt).toHaveLength(1 + 55);
    expect(run.portfolio.values['6']).toBe('2026-10-30');
    const other = runPipeline('nexus_holdings_demo.csv', { choice: { portfolio: 'Demo: Nordic Equity Fund', date: '2026-07-31' }, portfolio: sek, fxUser });
    expect(other.files[0].rows).toHaveLength(13);
    expect(other.portfolio.values['6']).toBe('2026-07-31');
  });

  it('maps the columns that matter and leaves the picker and model inputs out', () => {
    expect(mapped).toMatchObject({
      Date: 'ignore', Portfolio: 'ignore', 'Instrument type': 'asset_type', Name: 'security_name', ISIN: 'isin', Quantity: 'quantity',
      Price: 'price', Currency: 'currency', 'Coupon %': 'coupon', 'Maturity / expiry': 'maturity_date', 'Market value override': 'market_value_local',
      'Fixed rate %': 'ignore', 'Risk-free rate %': 'ignore', 'Avg daily volume': 'ignore', 'Buy amount': 'ignore', 'Sell currency': 'ignore',
    });
    for (const p of run.predictions) if (p.field !== 'ignore') expect(p.confidence, p.header).toBeGreaterThanOrEqual(0.1);
  });

  it('derives the CIC from the instrument type and name, for every kind of holding', () => {
    const cic = (name: string) => String(byName(name)[col('12')]);
    expect(cic('Investor B')).toBe('SE31');
    expect(cic('Sweden 0.75% 2029')).toBe('SE11');
    expect(cic('Volvo Treasury 3.625% 2029').slice(2)).toBe('21');
    expect(cic('Stadshypotek 1.50% 2028 (covered)').slice(2)).toBe('27');
    expect(cic('Swedish T-bill').slice(2)).toBe('15');
    expect(cic('Nordea commercial paper').slice(2)).toBe('23');
    expect(cic('Custody account SEK')).toBe('XT71');
    expect(cic('OMXS30 Index Future')).toBe('XLA1');
    expect(cic('Euro-Bund Future').slice(2)).toBe('A2');
    expect(cic('Brent Crude Future').slice(2)).toBe('A5');
    expect(cic('OMXS30 Put 2400').slice(2)).toBe('C1');
    expect(cic('Volvo B Call 270')[2]).toBe('B');
    expect(cic('USD put / SEK call 9.60').slice(2)).toBe('C3');
    expect(cic('Sell USD / buy SEK')).toBe('XTE2');
    expect(cic('SEK 7y payer swap')).toBe('XTD1');
    expect(cic('iTraxx Crossover 5y')).toBe('XTF1');
  });

  it('values what the file values, and guesses nothing for model-valued derivatives', () => {
    const v = (name: string, id: string) => byName(name)[col(id)];
    expect([v('Investor B', '18'), v('Investor B', '22')]).toEqual([212766, 62000012.4]);
    expect([v('Sweden 0.75% 2029', '19'), v('Sweden 0.75% 2029', '23'), v('Sweden 0.75% 2029', '33')]).toEqual([73000000, 70007000, 0.75]);
    // Cash: the balance is the value; NOK converted with the rate entered in step 3.
    expect([v('Custody account NOK', '19'), v('Custody account NOK', '22'), v('Custody account NOK', '24')]).toEqual([4500000, 4500000, 4050000]);
    // Futures: the file's market value 0, not contracts × price.
    expect([v('OMXS30 Index Future', '18'), v('OMXS30 Index Future', '22')]).toEqual([-120, 0]);
    // Options and swaps need a pricing model: blank, not guessed.
    for (const name of ['Volvo B Call 270', 'SEK 7y payer swap', 'iTraxx Crossover 5y']) expect(v(name, '22'), name).toBeNull();
  });

  it('every written value passes the spec validation and the report has no errors', () => {
    for (const row of tpt.slice(1)) {
      row.forEach((x, j) => {
        if (x !== null) expect(validateFieldValue(spec.fields[j], x), `${spec.fields[j].header} = ${x}`).toBeUndefined();
      });
    }
    expect(run.reports[0].summary.errors).toBe(0);
  });
});
