/**
 * Test helper: run a sample file through the whole pipeline exactly as the app does
 * (read → detect table → classify columns → normalise → FX → resolve → build TPT →
 * quality report → write xlsx/csv), without the UI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { readWorkbook } from '../src/ingest/readFile.ts';
import { detectTable } from '../src/ingest/table.ts';
import type { CanonicalField } from '../src/detect/canonical.ts';
import { normalizeHoldings } from '../src/derive/holdings.ts';
import { buildFxTable, guessPortfolioCurrency, impliedFxRates } from '../src/derive/valuation.ts';
import { DEFAULT_CONVENTIONS, resolveHoldings } from '../src/derive/resolve.ts';
import { interpretAmounts } from '../src/derive/amounts.ts';
import { baseCurrencyOf, emptyPortfolio, fundNav, type PortfolioState } from '../src/portfolio/portfolio.ts';
import { buildTptFiles } from '../src/export/buildTpt.ts';
import { buildQualityReport } from '../src/export/quality.ts';
import { writeQualityXlsx, writeTptCsv, writeTptXlsx } from '../src/export/write.ts';
import { spec } from '../src/spec/index.ts';
import { dateFromMetadata, predict } from '../src/ui/session.ts';
import { applySplit, detectSplit, withDefaultSplit, type SplitChoice } from '../src/ingest/split.ts';

export const SAMPLES = resolve(import.meta.dirname, '../samples');

export interface PipelineOptions {
  /** Portfolio data; defaults to fund level with the suggested currency and valuation date. */
  portfolio?: (p: PortfolioState) => void;
  /** Column mapping overrides by header. */
  mapping?: Record<string, CanonicalField>;
  fxUser?: Record<string, number>;
  /** Portfolio and date to convert from a multi-portfolio / multi-date file (default: first portfolio, latest date). */
  choice?: SplitChoice;
}

export function runPipeline(file: string, opts: PipelineOptions = {}) {
  const wb = readWorkbook(new Uint8Array(readFileSync(resolve(SAMPLES, file))), file);
  const sheet = wb.sheets[0];
  const full = detectTable(sheet.rows);
  const split = detectSplit(full);
  const table = opts.choice && split ? applySplit(full, split, opts.choice) : withDefaultSplit(full);
  // Same column prediction as the app (including the pinned portfolio / date columns).
  const predictions = predict(table);
  const mapping = predictions.map((p) => opts.mapping?.[p.header] ?? p.field);
  const norm = normalizeHoldings(table, mapping);
  const implied = impliedFxRates(norm.holdings);
  const guess = guessPortfolioCurrency(norm.holdings, norm.portfolioValueHeader);

  const portfolio = emptyPortfolio();
  portfolio.values['4'] = guess.currency ?? '';
  portfolio.values['6'] = table.split?.choice.date ?? dateFromMetadata(table) ?? '2026-09-30';
  portfolio.fxUser = opts.fxUser ?? {};
  opts.portfolio?.(portfolio);

  const base = baseCurrencyOf(portfolio);
  const ccys = [
    ...norm.holdings.map((h) => h.file.currency).filter((c): c is string => !!c),
    ...(portfolio.level === 'share_class' ? portfolio.shareClasses.map((c) => c.values['4']).filter(Boolean) : []),
    ...(base ? [base] : []),
  ];
  const fx = buildFxTable(ccys, base, implied, portfolio.fxUser);
  const nav = fundNav(portfolio, (c) => fx.table[c]?.rate).nav;
  const amounts = interpretAmounts(norm.holdings, { portfolioCurrency: base, fx: (c) => fx.table[c]?.rate, nav, totals: table.totals });
  const result = resolveHoldings(amounts.holdings, {
    ...portfolio.conventions,
    ...DEFAULT_CONVENTIONS,
    valuationDate: portfolio.values['6'] || undefined,
    portfolioCurrency: base,
    fx: fx.table,
    nav,
  });
  const files = buildTptFiles(result, portfolio, fx.table, { today: '2026-10-05', freeText: 'e2e' });
  const reports = files.map(buildQualityReport);
  return { wb, table, predictions, mapping, norm, implied, guess, portfolio, fx, amounts, result, files, reports };
}

/** Write the TPT workbook and read it back as a 2-D array (what a recipient would see). */
export function roundTripXlsx(file: ReturnType<typeof runPipeline>['files'][number], includeSource = true) {
  const wb = XLSX.read(writeTptXlsx(file, includeSource), { type: 'array' });
  return { wb, tpt: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.TPT, { header: 1, defval: null }) };
}

export const col = (id: string) => spec.fields.findIndex((f) => f.id === id);
export { writeTptCsv, writeQualityXlsx };
