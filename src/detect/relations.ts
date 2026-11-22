/**
 * Relations between columns, found in the numbers themselves: which column is another column times
 * a third (quantity × price = value, or nominal × price ÷ 100 = value), which is another column
 * converted with one rate per currency (local value → portfolio value), and which is another
 * column's share of its total (value → weight).
 *
 * Headers can be wrong, generic ("Col6") or missing; these relations cannot. classify.ts turns
 * them into evidence for the fields of the columns involved and then assigns all columns at once.
 */
import type { CanonicalField } from './canonical.ts';

export interface Product {
  /** Column indices: a × b = c (or a × b ÷ 100 = c for bond rows). */
  a: number;
  b: number;
  c: number;
  /** Share of the rows with all three numbers where the product holds. */
  support: number;
  rows: number;
}
export interface FxPair {
  local: number;
  port: number;
  support: number;
  rows: number;
}
export interface WeightOf {
  value: number;
  weight: number;
  support: number;
}
export interface Relations {
  products: Product[];
  fx: FxPair[];
  weights: WeightOf[];
}

const near = (x: number, y: number, tol = 0.005) => Math.abs(x - y) <= Math.max(1e-9, Math.abs(y) * tol);

/** Numeric columns: at least half the filled cells are numbers, and not every value is the same. */
function numericColumns(numbers: (number | undefined)[][]): number[] {
  return numbers
    .map((col, i) => ({ i, vals: col.filter((v): v is number => v !== undefined) }))
    .filter(({ vals }) => vals.length >= 2 && new Set(vals).size > 1)
    .map(({ i }) => i);
}

export function findRelations(numbers: (number | undefined)[][], currencyCol?: (string | undefined)[]): Relations {
  const cols = numericColumns(numbers);
  const nRows = numbers[0]?.length ?? 0;
  const products: Product[] = [];
  for (const c of cols) {
    for (let x = 0; x < cols.length; x++) {
      for (let y = x + 1; y < cols.length; y++) {
        const a = cols[x];
        const b = cols[y];
        if (a === c || b === c) continue;
        let rows = 0;
        let hits = 0;
        let trivial = 0;
        for (let r = 0; r < nRows; r++) {
          const va = numbers[a][r];
          const vb = numbers[b][r];
          const vc = numbers[c][r];
          if (va === undefined || vb === undefined || vc === undefined || !va || !vb || !vc) continue;
          rows++;
          if (near(va * vb, vc) || near((va * vb) / 100, vc)) {
            hits++;
            // A factor of 1 makes the "product" a copy of the other column: no evidence.
            if (Math.abs(va) === 1 || Math.abs(vb) === 1) trivial++;
          }
        }
        if (rows >= 2 && hits >= 2 && hits - trivial >= 2 && hits / rows >= 0.5) products.push({ a, b, c, support: hits / rows, rows });
      }
    }
  }

  const fx: FxPair[] = [];
  if (currencyCol) {
    for (const l of cols) {
      for (const p of cols) {
        if (l === p) continue;
        // One rate per currency, and one currency at rate 1 (the portfolio currency) or all rates ≠ 1.
        const rates = new Map<string, number[]>();
        let rows = 0;
        for (let r = 0; r < nRows; r++) {
          const vl = numbers[l][r];
          const vp = numbers[p][r];
          const ccy = currencyCol[r];
          if (vl === undefined || vp === undefined || !vl || !vp || !ccy) continue;
          rows++;
          (rates.get(ccy) ?? rates.set(ccy, []).get(ccy)!).push(vp / vl);
        }
        if (rows < 3 || rates.size < 2) continue;
        let consistent = 0;
        let unit = false;
        for (const rs of rates.values()) {
          const med = [...rs].sort((u, v) => u - v)[Math.floor(rs.length / 2)];
          consistent += rs.filter((x) => near(x, med, 0.002)).length;
          if (near(med, 1, 1e-6)) unit = true;
        }
        // At least one currency must convert at a rate other than 1, or the columns are just copies.
        const allUnit = [...rates.values()].every((rs) => rs.every((x) => near(x, 1, 1e-6)));
        if (!allUnit && unit && consistent / rows >= 0.8) fx.push({ local: l, port: p, support: consistent / rows, rows });
      }
    }
  }

  const weights: WeightOf[] = [];
  for (const v of cols) {
    const total = numbers[v].reduce<number>((s, x) => s + (x ?? 0), 0);
    if (!total) continue;
    for (const w of cols) {
      if (w === v) continue;
      let rows = 0;
      let hits = 0;
      for (let r = 0; r < nRows; r++) {
        const vv = numbers[v][r];
        const vw = numbers[w][r];
        if (vv === undefined || vw === undefined || !vv) continue;
        rows++;
        const share = vv / total;
        if (near(vw, share, 0.01) || near(vw, share * 100, 0.01) || Math.abs(vw - share) < 2e-6 || Math.abs(vw - share * 100) < 2e-4) hits++;
      }
      if (rows >= 3 && hits / rows >= 0.7) weights.push({ value: v, weight: w, support: hits / rows });
    }
  }
  return { products, fx, weights };
}

/** Evidence for each column's field from the relations: a log-score bonus per field, and why. */
export interface RelationEvidence {
  bonus: Map<CanonicalField, number>;
  reasons: string[];
}

const HOLDING: CanonicalField[] = ['quantity', 'nominal', 'amount_mixed'];
const VALUE: CanonicalField[] = ['market_value_local', 'market_value_portfolio'];

export function relationEvidence(rel: Relations, headers: string[], priceLike: (col: number) => number): RelationEvidence[] {
  const ev: RelationEvidence[] = headers.map(() => ({ bonus: new Map(), reasons: [] }));
  const add = (col: number, fields: CanonicalField[], amount: number, reason: string) => {
    for (const f of fields) ev[col].bonus.set(f, Math.max(ev[col].bonus.get(f) ?? 0, amount));
    if (!ev[col].reasons.includes(reason)) ev[col].reasons.push(reason);
  };
  const strength = (support: number) => (support >= 0.8 ? 3 : 2);
  for (const p of rel.products) {
    const s = strength(p.support);
    const pct = `${Math.round(p.support * 100)}%`;
    add(p.c, VALUE, s, `"${headers[p.c]}" = "${headers[p.a]}" × "${headers[p.b]}" in ${pct} of rows: a market value`);
    // Of the two factors, the one that looks more like a price is the price.
    const [price, amount] = priceLike(p.a) >= priceLike(p.b) ? [p.a, p.b] : [p.b, p.a];
    add(price, ['price'], s - 1, `Multiplies "${headers[amount]}" to give "${headers[p.c]}" (${pct} of rows): a price`);
    add(amount, HOLDING, s - 1, `Multiplied by "${headers[price]}" gives "${headers[p.c]}" (${pct} of rows): a holding amount`);
  }
  for (const f of rel.fx) {
    const pct = `${Math.round(f.support * 100)}%`;
    add(f.local, ['market_value_local'], 2.5, `× one rate per currency = "${headers[f.port]}" (${pct} of rows): the local-currency value`);
    add(f.port, ['market_value_portfolio'], 2.5, `= "${headers[f.local]}" × one rate per currency (${pct} of rows): the portfolio-currency value`);
  }
  for (const w of rel.weights) {
    add(w.weight, ['weight'], 2.5, `Each row's share of "${headers[w.value]}" (${Math.round(w.support * 100)}% of rows): a weight`);
  }
  return ev;
}
