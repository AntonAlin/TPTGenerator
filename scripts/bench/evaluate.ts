/**
 * Score one benchmark file: run it through the converter exactly as the app does (the user enters
 * the portfolio currency, the valuation date and FX rates, as in step 3) and compare the TPT with
 * the answer key, column by column and field by field.
 */
import { runPipeline, col } from '../../tests/pipeline.ts';
import type { BenchCase } from './render.ts';
import type { BenchHolding } from './holdings.ts';

export const CHECKS = [
  'found', 'cic', 'identifier', 'holding', 'currency', 'mv_local', 'mv_portfolio', 'weight', 'coupon', 'maturity',
  'contract_size', 'strike', 'call_put', 'underlying_price', 'delta', 'modified_duration',
] as const;
export type Check = (typeof CHECKS)[number];

export interface CaseResult {
  layout: string;
  file: string;
  mapping: { header: string; expect: string; got: string; ok: boolean }[];
  checks: Partial<Record<Check, [number, number]>>;
  failures: string[];
  rows: number;
  validationErrors: number;
}

const close = (a: unknown, b: number, tol: number) => typeof a === 'number' && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-6);
const DERIVATIVE = new Set(['forward', 'future', 'option', 'irs']);

export function evaluateCase(c: BenchCase): CaseResult {
  const { portfolio: p, layout } = c;
  const fxUser = Object.fromEntries(Object.entries(p.fx).filter(([k]) => k !== p.base));
  const run = runPipeline(c.path, {
    portfolio: (s) => {
      s.values['4'] = p.base;
      s.values['6'] = c.date;
    },
    fxUser,
  });
  const tpt = run.files[0].rows.map((r) => r.map((x) => x?.value));
  const v = (row: unknown[], id: string) => row[col(id)];
  const scale = layout.scale ?? 1;
  const mvTol = scale > 1 ? scale * 0.06 : 0.011;

  const mapping = run.predictions.map((pr) => {
    const colSpec = layout.columns.find((x) => x.header === pr.header);
    const expect = colSpec?.expect ?? '?';
    return { header: pr.header, expect, got: pr.field, ok: expect.split('|').includes(pr.field) };
  });
  const has = (field: string) => layout.columns.some((x) => x.expect.split('|')[0] === field);
  // NAV the TPT used: entered by nobody here, so the sum of the holdings' values incl. accrued (field 24).
  const fileWeights = layout.columns.some((x) => x.expect === 'weight');
  const navTpt = tpt.reduce((a, r) => a + (typeof v(r, '24') === 'number' ? (v(r, '24') as number) : 0), 0);

  const checks: CaseResult['checks'] = {};
  const failures: string[] = [];
  const score = (k: Check, ok: boolean, h: BenchHolding, detail: string) => {
    const [a, n] = checks[k] ?? [0, 0];
    checks[k] = [a + (ok ? 1 : 0), n + 1];
    if (!ok) failures.push(`${k}: ${h.name} (${h.kind}) ${detail}`);
  };
  for (const h of p.holdings) {
    const row = tpt.find((r) => v(r, '17') === h.name);
    score('found', !!row, h, 'not in the TPT');
    if (!row) continue;
    score('cic', String(v(row, '12') ?? '')[2] === h.cicCategory, h, `CIC ${v(row, '12')} want category ${h.cicCategory}`);
    if (h.isin && layout.columns.some((x) => x.expect.includes('isin'))) score('identifier', v(row, '14') === h.isin, h, `14=${v(row, '14')}`);
    const q = v(row, '18');
    const n = v(row, '19');
    const holdingOk =
      h.holdingIs === 'quantity' || h.holdingIs === 'contracts'
        ? close(q, h.holding, 1e-6) && (n === undefined || h.kind === 'future' || h.kind === 'option')
        : close(n, h.holding, 1e-6) && q === undefined;
    score('holding', holdingOk, h, `18=${q} 19=${n} want ${h.holdingIs} ${h.holding}`);
    score('currency', v(row, '21') === h.currency, h, `21=${v(row, '21')} want ${h.currency}`);
    const c23 = v(row, '23');
    const c25 = v(row, '25');
    if (h.notionalShownAsValue) {
      score('mv_local', c23 === undefined, h, `23=${c23} want blank (notional shown as value)`);
      score('mv_portfolio', c25 === undefined, h, `25=${c25} want blank`);
    } else {
      score('mv_local', close(c23, h.mvLocal, mvTol), h, `23=${c23} want ${h.mvLocal}`);
      score('mv_portfolio', close(c25, h.mvPortfolio, mvTol * 1.5 + 0.02), h, `25=${c25} want ${h.mvPortfolio}`);
      // A weight column in the file is used as it is; otherwise the TPT's weight is the value including
      // accrued interest (field 24) over the NAV, which is the sum of those values here.
      const w = fileWeights ? h.mvPortfolio / p.total : typeof v(row, '24') === 'number' ? (v(row, '24') as number) / navTpt : undefined;
      score('weight', w !== undefined && close(v(row, '26'), w, 2e-6) && close(v(row, '25'), h.mvPortfolio, mvTol * 1.5 + 0.02), h, `26=${v(row, '26')} want ${w?.toFixed(6)}`);
    }
    if (h.coupon !== undefined && (has('coupon') || /%/.test(h.name))) score('coupon', v(row, '33') === h.coupon, h, `33=${v(row, '33')} want ${h.coupon}`);
    if (h.maturity && !DERIVATIVE.has(h.kind) && h.kind !== 'cash' && (has('maturity_date') || /\d{2}\/\d{2}\/\d{4}/.test(h.name))) {
      score('maturity', v(row, '39') === h.maturity, h, `39=${v(row, '39')} want ${h.maturity}`);
    }
    // Fields that need input columns the converter may learn to read (scored where the file has them).
    const carried = (header: RegExp) => layout.columns.some((x) => header.test(x.header));
    if (h.contractSize !== undefined && carried(/multiplier|contract size/i)) score('contract_size', v(row, '20') === h.contractSize, h, `20=${v(row, '20')} want ${h.contractSize}`);
    if (h.strike !== undefined && carried(/strike/i)) score('strike', v(row, '61') === h.strike, h, `61=${v(row, '61')} want ${h.strike}`);
    if (h.callPut && carried(/call ?\/ ?put/i)) score('call_put', v(row, '60') === (h.callPut === 'call' ? 'Cal' : 'Put'), h, `60=${v(row, '60')}`);
    if (h.underlyingPrice !== undefined && carried(/underlying price/i)) score('underlying_price', v(row, '72') === h.underlyingPrice, h, `72=${v(row, '72')} want ${h.underlyingPrice}`);
    if (h.delta !== undefined && carried(/delta/i)) score('delta', v(row, '93') === h.delta, h, `93=${v(row, '93')} want ${h.delta}`);
    if (h.modifiedDuration !== undefined && carried(/duration/i)) score('modified_duration', close(v(row, '90'), h.modifiedDuration, 1e-6), h, `90=${v(row, '90')} want ${h.modifiedDuration}`);
  }
  const extra = tpt.length - p.holdings.filter((h) => tpt.some((r) => v(r, '17') === h.name)).length;
  if (extra > 0) failures.push(`${extra} row(s) in the TPT that are not holdings`);
  return { layout: layout.id, file: c.file, mapping, checks, failures, rows: tpt.length, validationErrors: run.reports[0].summary.errors };
}
