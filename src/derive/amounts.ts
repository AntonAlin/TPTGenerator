/**
 * Cell-level interpretation of amount columns.
 *
 * Holdings files often put different things in the same column: shares for
 * equities, nominal for bonds, the balance for cash, the notional for FX
 * forwards and swaps, contracts for futures — and some reports even show a
 * derivative's notional in the market value columns. This module decides, for
 * every row, what each amount cell really is, and sorts it into the right field.
 *
 * Method (math and logic, no reference data):
 *  1. Row kind from the asset class (units / bond / cash / listed or OTC derivative).
 *  2. Every assignment of roles (quantity, nominal/notional, market value local,
 *     market value portfolio, or "other": a value that is none of these, e.g. a
 *     duplicated notional) to the row's amount cells gets a score from:
 *       - the column mapping (reading a cell differently from its column costs points),
 *       - plausibility of the role for the row kind,
 *       - arithmetic identities: quantity × price = value; nominal × price ÷ 100
 *         (+ accrued) = value; local value × FX = portfolio value; cash amount = value;
 *         value ÷ NAV = weight (also with a value derived from quantity or nominal);
 *         a derivative "market value" of more than 25% of NAV is implausible.
 *     Scores become probabilities with a softmax; the best assignment wins.
 *  3. NAV for the weight check is the entered NAV, or estimated in two passes from
 *     rows whose reading is clear (value ÷ weight).
 *  4. Table check: when the file has a total row, uncertain cells are re-read if
 *     that is the only way the column's market values add up to the total. A
 *     derivative's notional duplicated in other value columns is discarded too.
 */
import { inferAssetClass, isEquitySwapText, ASSET_CLASSES, type AssetClass } from './assetClass.ts';
import type { AmountCell, AmountField, Holding } from './holdings.ts';
import type { TotalRow } from '../ingest/table.ts';
import { parseNumber } from '../ingest/values.ts';
import type { Confidence } from './provenance.ts';

export type AmountRole = 'quantity' | 'nominal' | 'mv_local' | 'mv_port' | 'other';
/** Roles that hold a value (at most one cell per row each). */
export const VALUE_ROLES: AmountRole[] = ['quantity', 'nominal', 'mv_local', 'mv_port'];
export const ROLE_LABEL: Record<AmountRole, string> = {
  quantity: 'quantity (units/contracts)',
  nominal: 'nominal / notional',
  mv_local: 'market value (local)',
  mv_port: 'market value (portfolio ccy)',
  other: 'not used (duplicate or other figure)',
};
const ROLE_FILE_FIELD = { quantity: 'quantity', nominal: 'nominal', mv_local: 'market_value_local', mv_port: 'market_value_portfolio' } as const;
const FIELD_ROLE: Record<AmountField, AmountRole | undefined> = {
  quantity: 'quantity',
  nominal: 'nominal',
  market_value_local: 'mv_local',
  market_value_portfolio: 'mv_port',
  amount_mixed: undefined,
};
const isMvRole = (r: AmountRole) => r === 'mv_local' || r === 'mv_port';

/** units = equities/funds (shares × price); bond = nominal × price ÷ 100; cash = amount;
 *  listed = futures/options/warrants (contracts); otc = forwards/swaps/CDS (notional). */
export type RowKind = 'units' | 'bond' | 'cash' | 'listed' | 'otc' | 'unknown';
const isDerivativeKind = (k: RowKind) => k === 'listed' || k === 'otc';

export interface CellInterpretation {
  cell: AmountCell;
  role: AmountRole;
  /** True if the role differs from what the column was mapped to (always true for mixed columns). */
  moved: boolean;
}

export interface AmountInterpretation {
  kind: RowKind;
  cells: CellInterpretation[];
  probability: number;
  confidence: Confidence;
  /** Why this interpretation was chosen (identities that hold, checks). */
  evidence: string[];
  /** Runner-up interpretation, for review. */
  runnerUp?: { description: string; probability: number };
}

export interface AmountContext {
  /** Portfolio (base) currency. */
  portfolioCurrency?: string;
  /** FX rate: 1 unit of `ccy` = rate units of the portfolio currency. */
  fx?: (ccy: string) => number | undefined;
  /** NAV in portfolio currency, if known. */
  nav?: number;
  /** Total rows of the table (for column-total checks). */
  totals?: TotalRow[];
}

export interface AmountsResult {
  holdings: Holding[];
  interpretations: (AmountInterpretation | undefined)[];
  /** Table-level findings, e.g. "column total matches after re-reading 1 cell". */
  notes: string[];
  /** NAV used for the weight checks, if any. */
  navEstimate?: number;
}

// ---------------------------------------------------------------------------

const KIND_OF: Partial<Record<AssetClass, RowKind>> = {
  cash: 'cash',
  deposit_short: 'cash',
  deposit_long: 'cash',
  future: 'listed',
  call_option: 'listed',
  put_option: 'listed',
  warrant: 'listed',
  swap: 'otc',
  forward: 'otc',
  credit_derivative: 'otc',
  other: 'unknown',
};

export function rowKind(cls: AssetClass): RowKind {
  if (KIND_OF[cls]) return KIND_OF[cls]!;
  if (ASSET_CLASSES[cls].isFixedIncome) return 'bond';
  return 'units';
}

// Cash: the template applies field 19 (nominal) to CIC 7 and field 18 (quantity) not at all, so a
// cash balance in a holding column is its nominal amount, not a number of units.
const KIND_PRIOR: Record<RowKind, Record<AmountRole, number>> = {
  units: { quantity: 0.5, nominal: -1.5, mv_local: 0, mv_port: 0, other: -2.5 },
  bond: { quantity: -0.7, nominal: 0.5, mv_local: 0, mv_port: 0, other: -2.5 },
  cash: { quantity: -2, nominal: 0.5, mv_local: 0.5, mv_port: 0.2, other: -2.5 },
  listed: { quantity: 0.5, nominal: -0.3, mv_local: 0, mv_port: 0, other: -2.5 },
  otc: { quantity: -1.5, nominal: 0.5, mv_local: 0, mv_port: 0, other: -2.5 },
  unknown: { quantity: 0, nominal: 0, mv_local: 0, mv_port: 0, other: -2.5 },
};

/** Cost of reading a cell as something other than what its column was mapped to. */
const MOVE_COST = 3;
/** Quantity and nominal are often confused in holdings files (a "Quantity" column holds bond nominals), so that move is cheaper. */
const QTY_NOMINAL_MOVE_COST = 1;

/** Closeness of a to b: 2 = exact (≤ 0.1%), 1 = close (≤ 1%), 0 = no match. */
function match(a: number, b: number): 0 | 1 | 2 {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return a === b ? 2 : 0;
  const rel = Math.abs(a - b) / Math.abs(b);
  if (rel <= 0.001 || Math.abs(a - b) <= 0.01) return 2;
  if (rel <= 0.01) return 1;
  return 0;
}

const fmt = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 1e6) / 1e6));

interface RowContext {
  kind: RowKind;
  price?: number;
  accrued?: number;
  fx?: number;
  weight?: number;
  navEst?: number;
}

interface Scored {
  roles: AmountRole[];
  score: number;
  evidence: string[];
}

/** Score one assignment of roles to the row's cells. */
function scoreAssignment(cells: AmountCell[], roles: AmountRole[], rc: RowContext): Scored {
  let score = 0;
  const evidence: string[] = [];
  const val: Partial<Record<AmountRole, number>> = {};
  const header: Partial<Record<AmountRole, string>> = {};
  cells.forEach((c, i) => {
    const r = roles[i];
    if (r !== 'other') {
      val[r] = c.value;
      header[r] = c.header;
    }
    const mapped = FIELD_ROLE[c.field];
    if (mapped && mapped !== r) {
      const qn = (x: AmountRole) => x === 'quantity' || x === 'nominal';
      score -= qn(mapped) && qn(r) ? QTY_NOMINAL_MOVE_COST : MOVE_COST;
    }
    score += KIND_PRIOR[rc.kind][r];
    // Shape: bond nominals and OTC notionals are usually round amounts.
    if (r === 'nominal' && rc.kind === 'bond' && Math.abs(c.value) >= 1000 && c.value % 1000 === 0) score += 0.3;
    if (r === 'nominal' && rc.kind === 'otc' && Math.abs(c.value) >= 10000 && c.value % 1000 === 0) score += 0.7;
  });
  const { price: P, accrued: AI, fx, weight: w, navEst } = rc;
  const Q = val.quantity;
  const N = val.nominal;
  const ML = val.mv_local;
  const MP = val.mv_port;
  // 0 × price = 0 holds for any reading: an identity with nothing on either side proves nothing
  // (a future's 0 value would otherwise "prove" that a 0 elsewhere is its contract count).
  const reward = (m: 0 | 1 | 2, full: number, text: string, sides: number[] = []) => {
    if (!m || sides.some((x) => x === 0)) return false;
    score += m === 2 ? full : full * 0.6;
    evidence.push(text + (m === 1 ? ' (within 1%)' : ''));
    return true;
  };

  if (P !== undefined && P !== 0) {
    if (Q !== undefined && ML !== undefined) reward(match(Q * P, ML), rc.kind === 'units' || rc.kind === 'listed' ? 4 : 2.5, `"${header.quantity}" × price = "${header.mv_local}" (${fmt(Q)} × ${fmt(P)} = ${fmt(ML)}) → units`, [Q, ML]);
    if (N !== undefined && ML !== undefined) {
      reward(match((N * P) / 100, ML), rc.kind === 'bond' ? 4 : 2.5, `"${header.nominal}" × price ÷ 100 = "${header.mv_local}" (${fmt(N)} × ${fmt(P)}% = ${fmt(ML)}) → nominal`, [N, ML]) ||
        (AI !== undefined && reward(match((N * P) / 100 + AI, ML), rc.kind === 'bond' ? 4 : 2.5, `"${header.nominal}" × price ÷ 100 + accrued = "${header.mv_local}" → nominal`, [N, ML]));
    }
    if (fx !== undefined && ML === undefined && MP !== undefined) {
      if (Q !== undefined) reward(match(Q * P * fx, MP), rc.kind === 'units' ? 3.5 : 2, `"${header.quantity}" × price × FX = "${header.mv_port}" → units`, [Q, MP]);
      if (N !== undefined) reward(match(((N * P) / 100) * fx, MP), rc.kind === 'bond' ? 3.5 : 2, `"${header.nominal}" × price ÷ 100 × FX = "${header.mv_port}" → nominal`, [N, MP]);
    }
  }
  if (ML !== undefined && MP !== undefined && fx !== undefined) {
    // Equal local and portfolio values in the portfolio currency are expected, so they count for less.
    if (!reward(match(ML * fx, MP), fx === 1 ? 1 : 3, `"${header.mv_local}" × FX ${fmt(fx)} = "${header.mv_port}"`) && Math.abs(ML) > 0 && Math.abs(MP) > 0) score -= 2.5;
  }
  if (rc.kind === 'cash') {
    const amount = ML ?? MP;
    for (const v of [Q, N]) {
      if (v !== undefined && amount !== undefined && match(v, amount) === 2) {
        score += 2;
        evidence.push('Cash: the amount equals the market value');
        break;
      }
    }
  }
  // A derivative's notional repeated in a value column (directly or converted with the FX rate) is
  // the same figure twice: read once as the notional, the copy is not a market value. Without this,
  // dropping a cell cost so much that the copy was read as a second notional or as the value.
  // The holding column's figure repeated in a value column, as it is or converted with the FX rate,
  // is the notional shown twice: a forward or swap is never worth its whole notional. (Equal local
  // and portfolio values are normal; only a repeat of the holding column counts.)
  const hc = cells.findIndex((c) => c.field === 'amount_mixed' || c.field === 'quantity' || c.field === 'nominal');
  if (isDerivativeKind(rc.kind) && hc >= 0 && Math.abs(cells[hc].value) >= 1000) {
    const H = cells[hc].value;
    cells.forEach((c, i) => {
      if (i === hc) return;
      const same = match(c.value, H) === 2 || (fx !== undefined && (match(c.value, H * fx) === 2 || match(c.value * fx, H) === 2));
      if (!same) return;
      if (isMvRole(roles[i])) score -= 6;
      else if (roles[i] === 'other') {
        score += 4;
        evidence.push(`"${c.header}" repeats the notional ${fmt(H)}${match(c.value, H) === 2 ? '' : ' in another currency'}: not a market value`);
      }
    });
  }
  // Weight and NAV: a market value in the file, or one derived from quantity/nominal × price.
  if (navEst && navEst > 0) {
    const fileValue = MP ?? (ML !== undefined && fx !== undefined ? ML * fx : undefined);
    let derivedValue: number | undefined;
    if (fileValue === undefined && P !== undefined && fx !== undefined) {
      if (N !== undefined && rc.kind === 'bond') derivedValue = ((N * P) / 100) * fx;
      else if (Q !== undefined && rc.kind === 'units') derivedValue = Q * P * fx;
    }
    const value = fileValue ?? derivedValue;
    if (value !== undefined) {
      const share = value / navEst;
      if (w !== undefined) {
        // Weights are usually given to 0.01 percentage point: allow ±0.5% (min. 0.02 pp), narrowing
        // for tiny positions, where 0.02 pp is more than the whole weight. A value of the opposite
        // sign to the weight never matches it.
        const tol = Math.max(0.0002 * Math.min(1, Math.abs(w) / 0.002 + 0.1), Math.abs(w) * 0.005);
        const signOk = !(share * w < 0);
        if (signOk && Math.abs(share - w) <= tol) {
          score += fileValue !== undefined ? 3 : 2.5;
          evidence.push(`${fileValue !== undefined ? 'Market value' : 'Value implied by this reading'} ÷ NAV = weight (${(share * 100).toFixed(2)}%)`);
        } else if (Math.abs(share) > 3 * Math.abs(w) + 0.05) score -= 3;
      }
      if (fileValue !== undefined && isDerivativeKind(rc.kind) && Math.abs(share) > 0.25) {
        score -= 2;
        evidence.push(`A derivative market value of ${(share * 100).toFixed(0)}% of NAV is implausible`);
      }
    }
  }
  return { roles, score, evidence };
}

/** All assignments for k cells: value roles at most once each, "other" any number of times. */
function assignments(k: number): AmountRole[][] {
  const out: AmountRole[][] = [];
  const rec = (acc: AmountRole[]) => {
    if (acc.length === k) return void out.push([...acc]);
    for (const r of VALUE_ROLES) if (!acc.includes(r)) rec([...acc, r]);
    rec([...acc, 'other']);
  };
  rec([]);
  return out;
}

const describe = (cells: AmountCell[], roles: AmountRole[]) => cells.map((c, i) => `"${c.header}" = ${ROLE_LABEL[roles[i]]}`).join(', ');
const confidenceOf = (p: number): Confidence => (p >= 0.9 ? 'high' : p >= 0.6 ? 'medium' : 'low');
const sameRoles = (a: AmountRole[], b: AmountRole[]) => a.every((r, i) => r === b[i]);

/** Score all assignments for a row, best first, with softmax probabilities. */
export function rankRow(cells: AmountCell[], rc: RowContext): (Scored & { p: number })[] {
  if (!cells.length) return [];
  const options = cells.length <= 4 ? assignments(cells.length) : [cells.map((c) => FIELD_ROLE[c.field] ?? 'other')];
  const scored = options.map((roles) => scoreAssignment(cells, roles, rc));
  const max = Math.max(...scored.map((s) => s.score));
  const exp = scored.map((s) => Math.exp(s.score - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return scored.map((s, i) => ({ ...s, p: exp[i] / sum })).sort((a, b) => b.p - a.p);
}

function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseNumber(v)?.value;
  return undefined;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function interpretAmounts(holdings: Holding[], ctx: AmountContext): AmountsResult {
  const notes: string[] = [];
  const fxOf = (h: Holding): number | undefined => {
    const c = h.file.currency;
    if (!c) return undefined;
    if (c === ctx.portfolioCurrency) return 1;
    return ctx.fx?.(c);
  };
  const kinds = holdings.map((h) => {
    const cls = inferAssetClass({
      name: h.file.security_name,
      assetTypeText: h.file.asset_type,
      section: h.section,
      isin: h.file.isin,
      hasCoupon: h.file.coupon !== undefined,
      hasMaturity: h.file.maturity_date !== undefined,
      price: h.file.price,
    }).assetClass;
    // A CFD or equity swap with a share price holds a number of shares, like a listed contract,
    // not a notional.
    if (cls === 'swap' && h.file.price !== undefined && isEquitySwapText(h.file.security_name, h.file.asset_type)) return 'listed' as RowKind;
    return rowKind(cls);
  });
  const cellsOf = (i: number) => holdings[i].amountCells ?? [];
  const rankAll = (navEst?: number) =>
    holdings.map((h, i) => rankRow(cellsOf(i), { kind: kinds[i], price: h.file.price, accrued: h.file.accrued_interest, fx: fxOf(h), weight: h.file.weight, navEst }));

  // NAV for the weight check: entered, else estimated from the mapped market value columns.
  let navEst = ctx.nav;
  if (!navEst) {
    const ratios: number[] = [];
    holdings.forEach((h, i) => {
      const w = h.file.weight;
      if (!w || isDerivativeKind(kinds[i])) return;
      const fx = fxOf(h);
      const mp = h.file.market_value_portfolio ?? (h.file.market_value_local !== undefined && fx !== undefined ? h.file.market_value_local * fx : undefined);
      if (mp) ratios.push(mp / w);
    });
    if (ratios.length >= 2) navEst = median(ratios);
  }
  let ranked = rankAll(navEst);

  // Second pass: re-estimate NAV from rows whose reading is clear, then re-rank.
  if (!ctx.nav && holdings.some((h) => h.file.weight)) {
    const ratios: number[] = [];
    holdings.forEach((h, i) => {
      const best = ranked[i][0];
      const w = h.file.weight;
      const fx = fxOf(h);
      // Bond and cash readings are reliable from the row type alone; others need a clear reading.
      const reliable = best && (best.p >= 0.5 || kinds[i] === 'bond' || kinds[i] === 'cash');
      if (!best || !reliable || !w || isDerivativeKind(kinds[i]) || fx === undefined) return;
      const v = (role: AmountRole) => cellsOf(i).find((_, k) => best.roles[k] === role)?.value;
      const P = h.file.price;
      const mp = v('mv_port');
      const ml = v('mv_local');
      const n = v('nominal');
      const value = mp ?? (ml !== undefined ? ml * fx : kinds[i] === 'bond' && n !== undefined && P ? ((n * P) / 100) * fx : undefined);
      if (value) ratios.push(value / w);
    });
    if (ratios.length >= 2) {
      const est = median(ratios);
      if (!navEst || Math.abs(est / navEst - 1) > 0.01) {
        navEst = est;
        ranked = rankAll(navEst);
        notes.push(`NAV estimated at ${fmt(est)} from rows whose value and weight are both known; used to check the other rows' weights.`);
      }
    }
  }

  const chosen: (AmountRole[] | undefined)[] = ranked.map((r) => r[0]?.roles);
  const forced = new Map<number, string>();

  // Table check against reported column totals.
  const grand = [...(ctx.totals ?? [])].reverse().find((t) => !t.subtotal) ?? ctx.totals?.at(-1);
  if (grand) {
    const cols = [...new Set(holdings.flatMap((h) => (h.amountCells ?? []).map((c) => c.col)))];
    for (const col of cols) {
      const total = numberOf(grand.cells[col]);
      if (total === undefined || total === 0) continue;
      const header = holdings.flatMap((h) => h.amountCells ?? []).find((c) => c.col === col)!.header;
      const idxIn = (ri: number) => cellsOf(ri).findIndex((c) => c.col === col);
      const sum = (choice: (AmountRole[] | undefined)[]) =>
        holdings.reduce((s, _, ri) => {
          const k = idxIn(ri);
          const r = choice[ri];
          return s + (k >= 0 && r && isMvRole(r[k]) ? cellsOf(ri)[k].value : 0);
        }, 0);
      // Report totals are exact sums of what the report shows: "adds up" means equal to rounding.
      const gap = Math.abs(sum(chosen) - total);
      if (gap <= Math.max(1, Math.abs(total) * 1e-7)) {
        notes.push(`Column "${header}": the market values add up to the reported total ${fmt(total)}.`);
        continue;
      }
      // Derivatives already read as showing their notional in this column (their copy dropped): the
      // total includes their real values, which the rows do not show. A gap that small is theirs.
      const dropped = holdings.reduce((a, _, ri) => {
        const k = idxIn(ri);
        return k >= 0 && chosen[ri]?.[k] === 'other' && isDerivativeKind(kinds[ri]) ? a + Math.abs(cellsOf(ri)[k].value) : a;
      }, 0);
      if (dropped > 0 && gap <= 0.05 * dropped && gap <= 0.02 * Math.abs(total)) {
        holdings.forEach((_, ri) => {
          const k = idxIn(ri);
          if (k >= 0 && chosen[ri]?.[k] === 'other' && isDerivativeKind(kinds[ri]) && !forced.has(ri)) {
            forced.set(ri, `Column "${header}" adds up to the reported total ${fmt(total)} without this figure (but for the derivatives' own values)`);
          }
        });
        notes.push(`Column "${header}": the market values add up to the reported total ${fmt(total)} but for ${fmt(gap)}, within what the derivatives read as showing their notional can be worth (their real values are in the total, not in the rows).`);
        continue;
      }
      // Candidate re-readings: a derivative's "market value" that is really something else
      // (typically the notional). Other rows' market values are not second-guessed here.
      const candidates = holdings
        .map((_, ri) => ri)
        .filter((ri) => {
          const k = idxIn(ri);
          const r = chosen[ri];
          return k >= 0 && !!r && isMvRole(r[k]) && isDerivativeKind(kinds[ri]);
        })
        .slice(0, 16);
      // A re-reading is acceptable when what is left of the gap could be the re-read derivatives'
      // own market values (the total includes them, the rows do not show them): at most 5% of the
      // re-read amounts (a forward or swap is rarely worth more than that share of its notional)
      // and 2% of the total (hedged share classes can carry notionals close to the NAV). Among acceptable re-readings, the one that changes
      // the fewest cells wins; a smaller remainder only breaks ties. (Choosing the smallest
      // remainder outright would also flip genuine small derivative values that happen to offset
      // the hidden ones.)
      let best: { mask: number; err: number } | undefined;
      for (let mask = 1; mask < 1 << candidates.length; mask++) {
        let flippedAmount = 0;
        const trial = chosen.map((r, ri) => {
          const b = candidates.indexOf(ri);
          if (b < 0 || !(mask & (1 << b))) return r;
          flippedAmount += Math.abs(cellsOf(ri)[idxIn(ri)].value);
          return r!.map((x, k) => (k === idxIn(ri) ? ('other' as AmountRole) : x));
        });
        const errAbs = Math.abs(sum(trial) - total);
        const err = errAbs / Math.abs(total);
        if (err > 0.02 || errAbs > 0.05 * flippedAmount || errAbs > 0.05 * gap) continue;
        const better = !best || popcount(mask) < popcount(best.mask) || (popcount(mask) === popcount(best.mask) && err < best.err);
        if (better) best = { mask, err };
      }
      if (best) {
        const flipped = candidates.filter((_, b) => best!.mask & (1 << b));
        for (const ri of flipped) {
          chosen[ri] = notAValue(cellsOf(ri), chosen[ri]!, idxIn(ri), fxOf(holdings[ri]));
          forced.set(ri, `Column "${header}" adds up to the reported total ${fmt(total)} only if this cell is not a market value`);
        }
        notes.push(`Column "${header}": total ${fmt(total)} matches after re-reading ${flipped.length} cell(s) as not market values (row${flipped.length > 1 ? 's' : ''} ${flipped.map((ri) => holdings[ri].row + 1).join(', ')}).`);
      }
    }
  }

  const interpretations: (AmountInterpretation | undefined)[] = [];
  const out = holdings.map((h, i) => {
    const cells = cellsOf(i);
    const roles = chosen[i];
    if (!cells.length || !roles) {
      interpretations.push(undefined);
      return h;
    }
    const rc = { kind: kinds[i], price: h.file.price, accrued: h.file.accrued_interest, fx: fxOf(h), weight: h.file.weight, navEst };
    const scored = ranked[i].find((o) => sameRoles(o.roles, roles)) ?? { ...scoreAssignment(cells, roles, rc), p: 0 };
    // In the portfolio currency, local and portfolio market value are the same thing:
    // readings that differ only in that respect are one reading.
    const key = (r: AmountRole[]) => (rc.fx === 1 ? r.map((x) => (x === 'mv_port' ? 'mv_local' : x)) : r).join('|');
    const same = ranked[i].filter((o) => key(o.roles) === key(roles)).reduce((a, o) => a + o.p, 0);
    const force = forced.get(i);
    const probability = force ? Math.max(0.95, same) : Math.max(same, scored.p);
    const runner = ranked[i].find((o) => key(o.roles) !== key(roles));
    const interp: AmountInterpretation = {
      kind: kinds[i],
      cells: cells.map((c, k) => ({ cell: c, role: roles[k], moved: FIELD_ROLE[c.field] !== roles[k] })),
      probability,
      confidence: confidenceOf(probability),
      evidence: [...(force ? [force] : []), ...scored.evidence],
      ...(runner ? { runnerUp: { description: describe(cells, runner.roles), probability: runner.p } } : {}),
    };
    if (!interp.evidence.length) interp.evidence.push(`No arithmetic check possible; read by column mapping and row type (${kinds[i]})`);
    interpretations.push(interp);
    // Re-sort the values into the fields they really belong to.
    const file = { ...h.file };
    for (const f of ['quantity', 'nominal', 'market_value_local', 'market_value_portfolio'] as const) delete file[f];
    for (const ci of interp.cells) if (ci.role !== 'other') file[ROLE_FILE_FIELD[ci.role]] = ci.cell.value;
    return { ...h, file, amounts: interp };
  });
  return { holdings: out, interpretations, notes, ...(navEst ? { navEstimate: navEst } : {}) };
}

/**
 * Re-read cell k as not a market value: it becomes the nominal/notional when no other cell
 * holds one, otherwise "other". Market values elsewhere in the row that are the same amount
 * (directly or converted with the FX rate) are the same duplicated figure and are dropped too.
 */
function notAValue(cells: AmountCell[], roles: AmountRole[], k: number, fx?: number): AmountRole[] {
  const next = [...roles];
  const v = cells[k].value;
  const same = (a: number) => match(a, v) === 2 || (fx !== undefined && (match(a, v * fx) === 2 || match(a * fx, v) === 2));
  // The same amount elsewhere in the row in local currency (not as a market value) is the notional itself.
  const localV = roles[k] === 'mv_port' && fx ? v / fx : v;
  // Prefer a cell not read as a value; else a cell read as the local value that holds the same
  // amount (a holding column taken for the local value because local × FX = the portfolio column).
  let holder = cells.findIndex((c, j) => j !== k && !isMvRole(next[j]) && match(c.value, localV) === 2);
  if (holder < 0) holder = cells.findIndex((c, j) => j !== k && next[j] === 'mv_local' && roles[k] === 'mv_port' && match(c.value, localV) === 2);
  if (holder >= 0) {
    next[holder] = 'nominal';
    next[k] = 'other';
    next.forEach((r, j) => {
      if (j !== holder && j !== k && r === 'nominal') next[j] = 'other';
    });
  } else next[k] = next.includes('nominal') ? 'other' : 'nominal';
  // Market values elsewhere in the row that are the same figure (directly or via FX) are duplicates.
  cells.forEach((c, j) => {
    if (j !== k && isMvRole(next[j]) && same(c.value)) next[j] = 'other';
  });
  return next;
}

function popcount(n: number) {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}
