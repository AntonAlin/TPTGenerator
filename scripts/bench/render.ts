/**
 * Write a benchmark file: a layout filled with generated holdings, plus the answer key for the
 * part the converter converts by default (the first fund on the latest date in a multi layout).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { generateHoldings, round, type BenchHolding, type BenchPortfolio } from './holdings.ts';
import { SECTION_ORDER, sectionOf, type Cell, type Ctx, type Layout } from './layouts.ts';

export interface BenchCase {
  layout: Layout;
  seed: number;
  file: string;
  path: string;
  /** What the converter should produce for its default choice. */
  portfolio: BenchPortfolio;
  date: string;
  fund?: string;
}

const DEFAULT_DATE = '2026-09-30';

/** Layouts without a total row or weights cannot reveal a forward's notional shown as its value. */
const canRevealNotional = (l: Layout) => !!l.total || l.columns.some((c) => c.expect === 'weight');

function portfolioFor(layout: Layout, seed: number, fundIndex: number, dateIndex: number, dateCount: number): BenchPortfolio {
  // Same holdings on every date of a fund, prices drifting a little between dates.
  const p = generateHoldings(seed * 7 + fundIndex * 1009, { base: layout.base, drift: (dateIndex - (dateCount - 1)) * 0.01 });
  const usesShownValues = layout.columns.some((c) => /market_value/.test(c.expect) && c.header !== 'Market value override');
  if (!usesShownValues || !canRevealNotional(layout)) for (const h of p.holdings) delete h.notionalShownAsValue;
  return p;
}

function rowsFor(layout: Layout, ctx: Ctx): Cell[][] {
  const header = layout.columns.map((c) => c.header);
  const out: Cell[][] = [];
  let sinceHeader = 0;
  const push = (r: Cell[]) => {
    if (layout.repeatHeaderEvery && sinceHeader >= layout.repeatHeaderEvery) {
      out.push([], header);
      sinceHeader = 0;
    }
    out.push(r);
    sinceHeader++;
  };
  const totalCol = layout.total ? header.indexOf(layout.total.column) : -1;
  for (const s of SECTION_ORDER) {
    const group = ctx.p.holdings.filter((h) => sectionOf(h) === s);
    if (!group.length) continue;
    if (layout.sections) out.push([layout.sections[s]]);
    for (const h of group) push(layout.columns.map((c) => c.cell(h, ctx)));
    if (layout.subtotalLabel && layout.sections && totalCol >= 0) {
      const sub = header.map((): Cell => null);
      sub[0] = `${layout.subtotalLabel} ${layout.sections[s].toLowerCase()}`;
      sub[totalCol] = round(group.reduce((a, h) => a + h.mvPortfolio, 0) / ctx.scale, ctx.scale > 1 ? 1 : 2);
      out.push(sub);
    }
  }
  if (layout.total && totalCol >= 0) {
    const tot = header.map((): Cell => null);
    tot[0] = layout.total.label;
    tot[totalCol] = round(ctx.p.total / ctx.scale, ctx.scale > 1 ? 1 : 2);
    const w = layout.columns.findIndex((c) => c.expect === 'weight');
    if (w >= 0) tot[w] = /fraction|Weight$/.test(layout.columns[w].header) && layout.id === 'en-bond-fund' ? 1 : 100;
    out.push(tot);
  }
  return out;
}

function writeFile(layout: Layout, aoa: Cell[][], path: string) {
  if (layout.format === 'csv') {
    const d = layout.delimiter ?? ',';
    const fmt = (v: Cell) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') {
        const s = v.toLocaleString(layout.locale ?? 'en-US', { maximumFractionDigits: 6 }).replace(/−/g, '-');
        return s.includes(d) ? `"${s}"` : s;
      }
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return s.includes(d) || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    writeFileSync(path, `﻿${aoa.map((r) => r.map(fmt).join(d)).join('\r\n')}\r\n`);
    return;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Holdings');
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: layout.format === 'xls' ? 'biff8' : 'xlsx' }) as Buffer);
}

export function renderCase(layout: Layout, seed: number, outDir: string): BenchCase {
  mkdirSync(outDir, { recursive: true });
  const scale = layout.scale ?? 1;
  const funds = layout.multi?.funds ?? [undefined];
  const dates = layout.multi?.dates ?? [DEFAULT_DATE];
  const header = layout.columns.map((c) => c.header);
  let truth: { p: BenchPortfolio; fund?: string; date: string } | undefined;
  const body: Cell[][] = [];
  funds.forEach((fund, fi) => {
    dates.forEach((date, di) => {
      const p = portfolioFor(layout, seed, fi, di, dates.length);
      body.push(...rowsFor(layout, { p, fund: fund ?? '', date, scale }));
      if (fi === 0 && di === dates.length - 1) truth = { p, fund, date };
    });
  });
  const pre = layout.preamble?.({ p: truth!.p, fund: truth!.fund ?? '', date: truth!.date, scale }) ?? [];
  const file = `${layout.id}_${seed}.${layout.format}`;
  const path = resolve(outDir, file);
  writeFile(layout, [...pre, header, ...body], path);
  return { layout, seed, file, path, portfolio: truth!.p, date: truth!.date, fund: truth!.fund };
}

export type { BenchHolding };
