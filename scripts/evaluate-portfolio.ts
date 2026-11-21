/**
 * Score the converter on random portfolios against their answer keys.
 *
 *   npx tsx scripts/evaluate-portfolio.ts <outDir> <seed> [count]
 *
 * Generates `count` portfolios from `seed`, runs each through the full pipeline
 * (same code as the app, no manual input) and compares the TPT output with the
 * answer key. Prints a detailed report for the first one and a summary for all,
 * and writes the first one's TPT and quality report next to it in `outDir`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePortfolio, type Truth, type TruthRow } from './random-portfolio.ts';
import { runPipeline, col, writeQualityXlsx } from '../tests/pipeline.ts';
import { writeTptXlsx } from '../src/export/write.ts';
import type { Resolved } from '../src/derive/provenance.ts';

interface RowResult {
  truth: TruthRow;
  found: boolean;
  holdingOk: boolean;
  mvLocalOk: boolean;
  mvPortOk: boolean;
  cicOk: boolean;
  detail: string;
  amountConfidence?: string;
}

const close = (a: unknown, b: number, tol = 0.011) => typeof a === 'number' && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-7);
const val = (r: Resolved | undefined) => r?.value;

export function evaluate(truth: Truth, outDir: string) {
  const run = runPipeline(resolve(outDir, truth.file));
  const file = run.files[0];
  // Match holdings on name + identifier: random names can repeat across issuers.
  const keyOf = (name: unknown, id: unknown) => `${String(name ?? '')}|${String(id ?? '')}`;
  const byName = new Map(run.result.rows.map((r, i) => [keyOf(r.attrs.name.value, r.attrs.identifier.value), i]));

  // Column mapping.
  const mapping = run.table.headers.map((h, i) => {
    const expected = truth.columns[h];
    const got = run.mapping[i];
    return { header: h, expected, got, ok: expected ? expected.split('|').includes(got) : false };
  });

  const rows: RowResult[] = truth.rows.map((t) => {
    const i = byName.get(keyOf(t.name, t.id || undefined));
    if (i === undefined) return { truth: t, found: false, holdingOk: false, mvLocalOk: false, mvPortOk: false, cicOk: false, detail: 'holding missing from the TPT' };
    const row = file.rows[i];
    const q = val(row[col('18')]);
    const n = val(row[col('19')]);
    let holdingOk: boolean;
    switch (t.holdingIs) {
      case 'quantity':
      case 'contracts':
        holdingOk = close(q, t.holding) && n === undefined;
        break;
      case 'nominal':
      case 'notional':
        holdingOk = close(n, t.holding) && q === undefined;
        break;
      case 'cash':
        // The template applies field 19 to cash (CIC 7) and field 18 not at all.
        holdingOk = close(n, t.holding) && q === undefined;
        break;
    }
    const clean = val(row[col('23')]);
    const cleanPort = val(row[col('25')]);
    const mvLocalOk = t.notionalShownAsValue ? clean === undefined : close(clean, t.mvLocal);
    const mvPortOk = t.notionalShownAsValue ? cleanPort === undefined : close(cleanPort, t.mvPortfolio, 0.02);
    const cic = String(val(row[col('12')]) ?? '');
    const cicOk = cic[2] === t.cicCategory;
    const detail = `18=${q ?? '·'} 19=${n ?? '·'} 23=${clean ?? '·'} 25=${cleanPort ?? '·'} CIC=${cic}`;
    return { truth: t, found: true, holdingOk, mvLocalOk, mvPortOk, cicOk, detail, amountConfidence: run.result.rows[i].holding.amounts?.confidence };
  });

  const extraRows = run.result.rows.length - rows.filter((r) => r.found).length;
  return {
    truth,
    run,
    mapping,
    rows,
    extraRows,
    currencyOk: run.portfolio.values['4'] === truth.baseCurrency,
    dateOk: run.portfolio.values['6'] === truth.valuationDate,
    errors: run.reports[0].summary.errors,
    notes: run.amounts.notes,
  };
}

function main() {
  const outDir = process.argv[2] ?? 'random-portfolios';
  const seed = Number(process.argv[3] ?? 1);
  const count = Number(process.argv[4] ?? 1);
  const totals = { portfolios: 0, holdings: 0, found: 0, holding: 0, mvLocal: 0, mvPort: 0, cic: 0, mapOk: 0, mapAll: 0, extra: 0, ccy: 0, date: 0, errors: 0, perfect: 0 };
  const failures: string[] = [];
  for (let k = 0; k < count; k++) {
    const truth = generatePortfolio(seed + k, outDir);
    const e = evaluate(truth, outDir);
    if (k === 0) {
      console.log(`\n=== ${truth.file}: ${truth.language}, ${truth.format}, base ${truth.baseCurrency}, ${truth.rows.length} holdings ===`);
      console.log('Column mapping:');
      for (const m of e.mapping) console.log(`  ${m.ok ? '✓' : '✗'} ${m.header.padEnd(28)} → ${m.got}${m.ok ? '' : `   (expected ${m.expected ?? '?'})`}`);
      console.log(`Skipped rows: ${e.run.table.skipped.map((s) => `${s.row + 1}:${s.reason}`).join(', ')}`);
      console.log(`Portfolio currency guessed: ${e.run.portfolio.values['4'] || '—'} ${e.currencyOk ? '✓' : '✗'} · valuation date: ${e.run.portfolio.values['6']} ${e.dateOk ? '✓' : '✗'}`);
      console.log('Holdings (holding cell → field, clean values, CIC):');
      for (const r of e.rows) {
        const ok = r.found && r.holdingOk && r.mvLocalOk && r.mvPortOk && r.cicOk;
        console.log(`  ${ok ? '✓' : '✗'} ${r.truth.name.slice(0, 42).padEnd(42)} ${r.truth.holdingIs.padEnd(9)} ${r.detail}${r.amountConfidence ? `  [${r.amountConfidence}]` : ''}${ok ? '' : `   ← holding ${r.holdingOk ? 'ok' : 'WRONG'}, local ${r.mvLocalOk ? 'ok' : 'WRONG'}, portfolio ${r.mvPortOk ? 'ok' : 'WRONG'}, CIC ${r.cicOk ? 'ok' : `WRONG (want ${r.truth.cicCategory})`}`}`);
      }
      if (e.notes.length) console.log(`Notes: ${e.notes.join(' | ')}`);
      console.log(`Validation errors: ${e.errors}`);
      const base = resolve(outDir, truth.file.replace(/\.[^.]+$/, ''));
      writeFileSync(`${base}.TPT.xlsx`, writeTptXlsx(e.run.files[0], true));
      writeFileSync(`${base}.quality.xlsx`, writeQualityXlsx(e.run.reports[0]));
      console.log(`Wrote ${base}.TPT.xlsx and ${base}.quality.xlsx`);
    }
    totals.portfolios++;
    totals.holdings += e.rows.length;
    totals.found += e.rows.filter((r) => r.found).length;
    totals.holding += e.rows.filter((r) => r.holdingOk).length;
    totals.mvLocal += e.rows.filter((r) => r.mvLocalOk).length;
    totals.mvPort += e.rows.filter((r) => r.mvPortOk).length;
    totals.cic += e.rows.filter((r) => r.cicOk).length;
    totals.mapOk += e.mapping.filter((m) => m.ok).length;
    totals.mapAll += e.mapping.length;
    totals.extra += e.extraRows;
    totals.ccy += e.currencyOk ? 1 : 0;
    totals.date += e.dateOk ? 1 : 0;
    totals.errors += e.errors;
    const perfect = e.rows.every((r) => r.found && r.holdingOk && r.mvLocalOk && r.mvPortOk && r.cicOk) && e.mapping.every((m) => m.ok) && !e.extraRows;
    if (perfect) totals.perfect++;
    else {
      const bad = [
        ...e.mapping.filter((m) => !m.ok).map((m) => `map "${m.header}"→${m.got} (want ${m.expected})`),
        ...e.rows.filter((r) => !(r.found && r.holdingOk && r.mvLocalOk && r.mvPortOk && r.cicOk)).map((r) => `${r.truth.kind} "${r.truth.name.slice(0, 30)}" ${r.detail}`),
        ...(e.extraRows ? [`${e.extraRows} extra row(s)`] : []),
      ];
      failures.push(`seed ${truth.seed} (${truth.language}/${truth.format}): ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` … +${bad.length - 4}` : ''}`);
    }
  }
  const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
  console.log(`\n=== Summary over ${totals.portfolios} random portfolios, ${totals.holdings} holdings ===`);
  console.log(`  holdings found (no total/subtotal leaked: ${totals.extra} extra rows)  ${pct(totals.found, totals.holdings)}`);
  console.log(`  column mapping correct                                    ${pct(totals.mapOk, totals.mapAll)}`);
  console.log(`  holding cell in the right field (18 vs 19)                ${pct(totals.holding, totals.holdings)}`);
  console.log(`  clean market value, local (23)                            ${pct(totals.mvLocal, totals.holdings)}`);
  console.log(`  clean market value, portfolio (25)                        ${pct(totals.mvPort, totals.holdings)}`);
  console.log(`  CIC category                                              ${pct(totals.cic, totals.holdings)}`);
  console.log(`  portfolio currency guessed                                ${pct(totals.ccy, totals.portfolios)}`);
  console.log(`  valuation date found                                      ${pct(totals.date, totals.portfolios)}`);
  console.log(`  validation errors                                         ${totals.errors}`);
  console.log(`  portfolios fully correct                                  ${totals.perfect}/${totals.portfolios}`);
  if (failures.length) console.log(`\nIssues:\n  ${failures.slice(0, 25).join('\n  ')}`);
}

// Run as a script only, not when the tests import evaluate().
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
