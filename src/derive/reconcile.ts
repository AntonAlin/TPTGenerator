/**
 * Reconciliation: does the converted portfolio add up to what the file itself says?
 *
 *  - Totals and sub-totals: every total row in the file against the sum of the rows it covers, per
 *    value column, as the file shows them and as converted (where cells were re-read, the two differ
 *    and the reason is given).
 *  - NAV: a net asset value written above or below the table ("Fondförmögenhet 1 234 567 890",
 *    "Total net assets: EUR 98.7m") against the sum of the holdings, and offered as field 5.
 *  - Weights: the file's weights sum to 100%, and each one is the row's value ÷ NAV.
 *  - FX: one rate per currency in the file, and the rate used in the TPT agrees with it.
 *  - Rows: quantity × price (× contract size, ÷ 100 for bonds) = market value.
 *
 * Nothing here changes a value: it reports, and flags the rows that do not reconcile.
 */
import type { CanonicalField } from '../detect/canonical.ts';
import type { DetectedTable, TotalRow } from '../ingest/table.ts';
import { parseNumber } from '../ingest/values.ts';
import type { Holding } from './holdings.ts';
import type { ResolvedHolding } from './resolve.ts';
import type { FxEntry } from './valuation.ts';
import { ASSET_CLASSES } from './assetClass.ts';

export type ReconStatus = 'ok' | 'warn' | 'info';

export interface ReconCheck {
  kind: 'total' | 'subtotal' | 'nav' | 'weights' | 'fx' | 'rows';
  label: string;
  /** What the file says. */
  expected?: number;
  /** What the rows add up to. */
  actual?: number;
  diff?: number;
  status: ReconStatus;
  detail: string;
}

export interface RowFlag {
  /** 1-based row in the sheet. */
  row: number;
  name: string;
  check: ReconCheck['kind'];
  message: string;
}

export interface Reconciliation {
  checks: ReconCheck[];
  flags: RowFlag[];
  /** A NAV written in the file outside the table, if one was found. */
  navFromFile?: { value: number; currency?: string; line: string };
}

export interface ReconcileInput {
  table: Pick<DetectedTable, 'headers' | 'skipped'>;
  mapping: CanonicalField[];
  holdings: Holding[];
  /** Total rows, scaled like the holdings (NormalizeResult.totals). */
  totals: TotalRow[];
  rows: ResolvedHolding[];
  fx: Record<string, FxEntry>;
  portfolioCurrency?: string;
  /** NAV entered by the user (portfolio currency). */
  nav?: number;
}

const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const DERIVATIVE = new Set(['future', 'call_option', 'put_option', 'warrant', 'swap', 'forward', 'credit_derivative']);

/** The unit values were rounded to: 1,000 or 1,000,000 for a file in thousands or millions, else 1. */
function roundingStep(values: number[]): number {
  const nz = values.filter((v) => v !== 0);
  if (!nz.length) return 1;
  for (const step of [1e6, 1e3]) if (nz.every((v) => Math.abs(v % step) < 1e-6)) return step;
  return 1;
}

const NAV_RE =
  /\b(net asset value|total net assets|nav|aum|fund (size|value)|portfolio value|total (fund|portfolio) value|fondf[oö]rm[oö]genhet|fondens v[aä]rde|nettotillg[aå]ngar|totalt fondv[aä]rde|fondsverm[oö]gen|fondvolumen|nettoinventarwert|actif net|actifs nets|encours)\b/i;
const SCALE_WORD: [RegExp, number][] = [[/\b(bn|billion|mrd|miljarder|milliarden)\b/i, 1e9], [/\b(m|mn|mio|million|millions|miljoner|msek|meur|musd)\b/i, 1e6], [/\b(k|thousand|tusen|tsek|teur|tusd|tkr)\b/i, 1e3]];

/** A NAV written in a metadata line: keyword, then a number, maybe a currency and a scale word. */
export function navFromLines(lines: string[]): Reconciliation['navFromFile'] {
  for (const line of lines) {
    const m = NAV_RE.exec(line);
    if (!m) continue;
    const after = line.slice(m.index + m[0].length);
    const nm = /(-?\d[\d\s.,' ]*\d|\d)/.exec(after);
    if (!nm) continue;
    const raw = nm[1].replace(/\s/g, '').replace(/'/g, '');
    const value = parseNumber(raw)?.value;
    if (value === undefined || !Number.isFinite(value) || Math.abs(value) < 1) continue;
    const tail = after.slice(nm.index + nm[0].length);
    const scale = SCALE_WORD.find(([re]) => re.test(tail.split(/[;|]/)[0]))?.[1] ?? 1;
    const currency = /\b([A-Z]{3})\b/.exec(after)?.[1];
    return { value: value * scale, currency, line: line.trim() };
  }
  return undefined;
}

export function reconcile(input: ReconcileInput): Reconciliation {
  const checks: ReconCheck[] = [];
  const flags: RowFlag[] = [];
  const { mapping, holdings, rows } = input;
  const nameOf = (h: Holding) => h.file.security_name ?? h.file.isin ?? `row ${h.row + 1}`;
  const flag = (h: Holding, check: RowFlag['check'], message: string) => flags.push({ row: h.row + 1, name: nameOf(h), check, message });
  const tptPort = (r: ResolvedHolding) => num(r.attrs.mv_port_clean.value);

  // --- Totals and sub-totals ------------------------------------------------------------------
  const valueCols = mapping
    .map((f, col) => ({ f, col }))
    .filter(({ f }) => f === 'market_value_local' || f === 'market_value_portfolio' || f === 'accrued_interest' || f === 'weight');
  const sorted = [...input.totals].sort((a, b) => a.row - b.row);
  let prevRow = -1;
  for (const t of sorted) {
    // A grand total covers every holding above it; a sub-total the ones since the previous total.
    const inGroup = holdings.filter((h) => h.row < t.row && (!t.subtotal || h.row > prevRow));
    const kind = t.subtotal ? 'subtotal' : 'total';
    const what = t.label ? `"${t.label}"` : `the unlabelled total in row ${t.row + 1}`;
    prevRow = t.row;
    if (!inGroup.length) continue;
    for (const { f, col } of valueCols) {
      const expected = num(t.cells[col]) ?? parseNumber(t.cells[col])?.value;
      if (expected === undefined) continue;
      const header = input.table.headers[col];
      const cellOf = (h: Holding) =>
        f === 'accrued_interest' ? h.file.accrued_interest : f === 'weight' ? h.file.weight : h.amountCells?.find((c) => c.col === col)?.value ?? num(h.file[f as 'market_value_local' | 'market_value_portfolio']);
      const ccys = new Set(inGroup.map((h) => h.file.currency).filter(Boolean));
      if (f === 'market_value_local' && ccys.size > 1) {
        checks.push({ kind, label: `${what}, "${header}"`, expected, status: 'info', detail: `The rows are in ${ccys.size} currencies (${[...ccys].join(', ')}): a sum of local-currency values cannot be checked.` });
        continue;
      }
      // Weights may be in % or as fractions; the file's total is in the same unit as its cells.
      const fileSum = inGroup.reduce((s, h) => s + (cellOf(h) ?? 0), 0);
      // The rows' weights were read as fractions (1 = 100%); the total row is in the column's own unit.
      // Whichever reading of the total is closer to the rows is its unit: a sub-total of 0.10 in a
      // column of percentages is 0.10%, not 10%.
      const expectedInUnits = f === 'weight' && Math.abs(expected / 100 - fileSum) < Math.abs(expected - fileSum) ? expected / 100 : expected;
      const diff = fileSum - expectedInUnits;
      // Rows rounded to thousands or millions each carry up to half a unit of rounding.
      const step = roundingStep(inGroup.map((h) => cellOf(h) ?? 0));
      const tol = f === 'weight' ? 0.0005 : Math.max(1, Math.abs(expectedInUnits) * 2e-6, step > 1 ? (step / 2) * (inGroup.length + 1) : 0);
      const ok = Math.abs(diff) <= tol;
      let status: ReconStatus = ok ? 'ok' : 'warn';
      let actual = fileSum;
      let detail = ok
        ? `The ${inGroup.length} row(s) add up to the file's ${kind}.`
        : `The ${inGroup.length} row(s) add up to ${fmt(fileSum)}, the file says ${fmt(expectedInUnits)}: ${fmt(diff)} apart. A row may be missing, hidden or counted twice in the file.`;
      // As converted: cells re-read as notionals no longer count as values.
      if (!ok && (f === 'market_value_portfolio' || f === 'market_value_local')) {
        const conv = (h: Holding) => (f === 'market_value_portfolio' ? tptPort(rows[h.index]) : num(rows[h.index]?.attrs.mv_local_clean.value)) ?? 0;
        const converted = inGroup.reduce((s, h) => s + conv(h), 0);
        const moved = inGroup.filter((h) => h.amountCells?.some((c) => c.col === col) && Math.abs((cellOf(h) ?? 0) - conv(h)) > 1);
        const movedSum = moved.reduce((s, h) => s + Math.abs(cellOf(h) ?? 0), 0);
        const gap = Math.abs(converted - expectedInUnits);
        const where = `${moved.length} cell(s) hold a notional printed in a value column (row${moved.length > 1 ? 's' : ''} ${moved.map((h) => h.row + 1).join(', ')}; see the Amounts tab)`;
        if (moved.length && gap <= tol) {
          status = 'ok';
          actual = converted;
          detail = `As converted, the ${inGroup.length} row(s) add up to the file's ${kind}. As shown they add up to ${fmt(fileSum)}: ${where}.`;
        } else if (moved.length && gap <= 0.05 * movedSum && gap <= 0.02 * Math.abs(expectedInUnits)) {
          status = 'info';
          actual = converted;
          detail = `As converted, the rows add up to ${fmt(converted)}, ${fmt(gap)} from the file's ${kind}: ${where}, and the ${kind} includes those derivatives' own market values, which the rows do not show.`;
        } else if (moved.length) {
          detail += ` As converted, they add up to ${fmt(converted)}: ${where}.`;
        }
      }
      checks.push({ kind, label: `${what}, "${header}"`, expected: expectedInUnits, actual, diff: actual - expectedInUnits, status, detail });
    }
  }

  // --- NAV ------------------------------------------------------------------------------------
  const lines = input.table.skipped.filter((s) => s.reason === 'above-header' || s.reason === 'note').map((s) => s.preview);
  const navFromFile = navFromLines(lines);
  const holdingsSum = rows.reduce((s, r) => s + (num(r.attrs.mv_port_dirty.value) ?? 0), 0);
  const navUsed = input.nav ?? navFromFile?.value;
  if (navFromFile) {
    const wrongCcy = navFromFile.currency && input.portfolioCurrency && navFromFile.currency !== input.portfolioCurrency;
    const d = holdingsSum - navFromFile.value;
    const share = navFromFile.value ? holdingsSum / navFromFile.value : 0;
    checks.push({
      kind: 'nav',
      label: `NAV in the file: "${navFromFile.line.slice(0, 80)}"`,
      expected: navFromFile.value,
      actual: holdingsSum,
      diff: d,
      status: wrongCcy ? 'warn' : Math.abs(1 - share) <= 0.02 ? 'ok' : 'warn',
      detail: wrongCcy
        ? `The NAV is in ${navFromFile.currency}, the portfolio currency is ${input.portfolioCurrency}.`
        : `The holdings (incl. accrued interest) are ${pct(share)} of it${Math.abs(1 - share) > 1e-4 ? `; the other ${fmt(-d)} is what the file does not list (receivables, fees payable, other liabilities)` : ''}.${input.nav === undefined ? ' It can be used as 5 · Net asset valuation in step 3.' : input.nav !== navFromFile.value ? ` You entered ${fmt(input.nav)} as the NAV.` : ''}`,
    });
  } else if (input.nav !== undefined) {
    const share = input.nav ? holdingsSum / input.nav : 0;
    checks.push({
      kind: 'nav',
      label: 'NAV entered in step 3',
      expected: input.nav,
      actual: holdingsSum,
      diff: holdingsSum - input.nav,
      status: Math.abs(1 - share) <= 0.02 ? 'ok' : 'warn',
      detail: `The holdings (incl. accrued interest) are ${pct(share)} of the NAV.${Math.abs(1 - share) > 0.02 ? ' More than 2% apart: check the NAV, the valuation date or missing rows.' : ''}`,
    });
  }

  // --- Weights ----------------------------------------------------------------------------------
  const withW = holdings.filter((h) => h.file.weight !== undefined);
  if (withW.length >= 2) {
    const sumW = withW.reduce((s, h) => s + h.file.weight!, 0);
    const ok = Math.abs(sumW - 1) <= 0.002;
    checks.push({
      kind: 'weights',
      label: 'Weights in the file',
      expected: 1,
      actual: sumW,
      diff: sumW - 1,
      status: ok ? 'ok' : 'info',
      detail: ok ? `The weights sum to ${pct(sumW)}.` : `The weights sum to ${pct(sumW)}: the file's NAV includes ${sumW < 1 ? 'more' : 'less'} than the rows listed (${pct(Math.abs(1 - sumW))}).`,
    });
    // Each weight against value ÷ NAV, where the NAV is known (entered, written, or implied by the weights).
    const base = navUsed ?? (Math.abs(sumW - 1) <= 0.002 ? holdingsSum : undefined);
    if (base) {
      let offRows = 0;
      for (const h of withW) {
        const r = rows[h.index];
        const mv = num(r?.attrs.mv_port_dirty.value);
        if (mv === undefined) continue;
        // Files weigh by the dirty or by the clean value: either agrees.
        const clean = num(r.attrs.mv_port_clean.value) ?? mv;
        const want = mv / base;
        const w = h.file.weight!;
        const off = (v: number) => Math.abs(w - v / base) > Math.max(0.0005, Math.abs(v / base) * 0.02);
        if (off(mv) && off(clean) && !DERIVATIVE.has(r.effectiveClass)) {
          offRows++;
          flag(h, 'weights', `Weight ${pct(w)} in the file, but value ÷ NAV is ${pct(want)}.`);
        }
      }
      if (offRows) checks.push({ kind: 'weights', label: 'Weight of each row', status: 'warn', detail: `${offRows} row(s) whose weight is not their value ÷ NAV (${fmt(base)}): flagged below.` });
    }
  }

  // --- FX ---------------------------------------------------------------------------------------
  const byCcy = new Map<string, { h: Holding; rate: number }[]>();
  for (const h of holdings) {
    const ccy = h.file.currency;
    const l = h.file.market_value_local;
    const p = h.file.market_value_portfolio;
    if (!ccy || !l || !p || ccy === input.portfolioCurrency) continue;
    (byCcy.get(ccy) ?? byCcy.set(ccy, []).get(ccy)!).push({ h, rate: p / l });
  }
  for (const [ccy, list] of byCcy) {
    const med = [...list.map((x) => x.rate)].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const outliers = list.filter((x) => Math.abs(x.rate / med - 1) > 0.002);
    for (const o of outliers) flag(o.h, 'fx', `${ccy} converted at ${o.rate.toPrecision(6)}, the other ${ccy} rows at ${med.toPrecision(6)}.`);
    const used = input.fx[ccy];
    const apart = used ? used.rate / med - 1 : 0;
    const status: ReconStatus = outliers.length || (used && used.source === 'user' && Math.abs(apart) > 0.005) ? 'warn' : 'ok';
    checks.push({
      kind: 'fx',
      label: `${ccy} → ${input.portfolioCurrency ?? 'portfolio currency'}`,
      expected: med,
      actual: used?.rate,
      diff: used ? used.rate - med : undefined,
      status,
      detail: [
        `The file converts ${list.length} ${ccy} row(s) at ${med.toPrecision(6)}${outliers.length ? `, ${outliers.length} of them at another rate (flagged below)` : ''}.`,
        used && used.source === 'user' && Math.abs(apart) > 1e-6 ? `You entered ${used.rate.toPrecision(6)} (${(apart * 100).toFixed(2)}% apart): the TPT uses your rate for rows without a portfolio-currency value.` : '',
      ].filter(Boolean).join(' '),
    });
  }

  // --- Each row's own arithmetic ------------------------------------------------------------------
  let rowOff = 0;
  let rowChecked = 0;
  for (const h of holdings) {
    const r = rows[h.index];
    if (!r || DERIVATIVE.has(r.effectiveClass) || r.effectiveClass === 'cash') continue;
    const f = h.file;
    const mv = f.market_value_local;
    const fi = !!ASSET_CLASSES[r.effectiveClass].isFixedIncome;
    const amount = fi ? f.nominal ?? f.quantity : f.quantity;
    if (mv === undefined || !mv || amount === undefined || f.price === undefined) continue;
    rowChecked++;
    const clean = (amount * f.price * (f.contract_size ?? 1)) / (fi ? 100 : 1);
    const dirty = clean + (f.accrued_interest ?? 0);
    const step = roundingStep([mv]);
    const close = (x: number) => Math.abs(x - mv) <= Math.max(1, Math.abs(mv) * 0.01, step > 1 ? step / 2 + 1 : 0);
    if (close(clean) || close(dirty) || (fi && close(amount * f.price))) continue;
    rowOff++;
    flag(h, 'rows', `${fi ? 'Nominal' : 'Quantity'} × price${fi ? ' ÷ 100' : ''} = ${fmt(clean)}, but the market value is ${fmt(mv)} (${(((mv - clean) / clean) * 100).toFixed(1)}% apart): check the price date, the quantity or the price unit.`);
  }
  if (rowChecked) {
    checks.push({
      kind: 'rows',
      label: 'Quantity × price = market value',
      status: rowOff ? 'warn' : 'ok',
      detail: rowOff ? `${rowOff} of ${rowChecked} row(s) do not add up within 1% (flagged below).` : `All ${rowChecked} row(s) with an amount, a price and a value add up within 1%.`,
    });
  }

  flags.sort((a, b) => a.row - b.row);
  return { checks, flags, ...(navFromFile ? { navFromFile } : {}) };
}
