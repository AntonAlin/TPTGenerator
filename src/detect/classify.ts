/**
 * Column classification: logistic-regression inference over the features,
 * one-to-one assignment, confidence and human-readable reasons.
 */
import modelJson from './model.json';
import { CANONICAL_FIELDS, CANONICAL_INFO, UNIQUE_FIELDS, type CanonicalField } from './canonical.ts';
import { extractFeatures, FEATURE_NAMES, type ColumnFeatures, type ColumnInput } from './features.ts';
import { findRelations, relationEvidence } from './relations.ts';

interface Model {
  featureNames: string[];
  classes: string[];
  weights: number[][];
  bias: number[];
  trainedAt: string;
  metrics: Record<string, unknown>;
}

export const model = modelJson as unknown as Model;

/** Below this probability a mapping is highlighted for review. */
export const LOW_CONFIDENCE = 0.6;
/**
 * Below this probability a column does not take a field at all and stays "ignore". Without it, a
 * column whose likely fields were taken by better columns fell through to whatever was left
 * ("Buy amount" → market value at 0%).
 */
export const MIN_CLAIM = 0.1;

/**
 * A column with too few values to judge by (under 20% of rows filled, at most two distinct values,
 * e.g. a "Market value override" column that only has 0 for the futures) gives the model almost
 * nothing but its header. When that header is an exact synonym of one field, the header decides:
 * the field gets at least this probability, which still leaves the mapping highlighted for review.
 */
const HEADER_ONLY_P = 0.55;
function headerOnlyField(col: ColumnInput, f: ColumnFeatures): CanonicalField | undefined {
  const filled = col.values.filter((v) => v != null && !(typeof v === 'string' && !v.trim()));
  if (!col.values.length || filled.length / col.values.length >= 0.2) return undefined;
  if (new Set(filled.map((v) => String(v))).size > 2) return undefined;
  const exact = model.classes.filter((c) => (f.named[`hdr_${c}`] ?? 0) >= 0.97);
  return exact.length === 1 ? (exact[0] as CanonicalField) : undefined;
}
function withFloor(p: number[], i: number, floor: number): number[] {
  if (i < 0 || p[i] >= floor) return p;
  const rest = 1 - p[i];
  return p.map((x, k) => (k === i ? floor : rest > 0 ? (x * (1 - floor)) / rest : 0));
}

export type MappingSource = 'model' | 'profile' | 'user';

export interface ColumnPrediction {
  index: number;
  header: string;
  /** Probability per canonical field, sorted descending. */
  ranked: { field: CanonicalField; p: number }[];
  /** Field assigned after resolving conflicts. */
  field: CanonicalField;
  confidence: number;
  source: MappingSource;
  reasons: string[];
  /** Decimal separator detected for the column's values, if any. */
  decimal?: ',' | '.';
  features: ColumnFeatures;
}

function checkModel(m: Model) {
  if (m.featureNames.length !== FEATURE_NAMES.length || m.featureNames.some((n, i) => n !== FEATURE_NAMES[i])) {
    throw new Error('model.json was trained with a different feature set. Retrain the model (see README).');
  }
  for (const c of m.classes) if (!(CANONICAL_FIELDS as readonly string[]).includes(c)) throw new Error(`Unknown class ${c} in model.json`);
}
checkModel(model);

export function predictProba(x: number[], m: Model = model): number[] {
  const z = m.weights.map((w, c) => w.reduce((s, wi, i) => s + wi * x[i], m.bias[c]));
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Plain-language evidence for why a column looks like `field`. */
export function explain(f: ColumnFeatures, field: CanonicalField): string[] {
  const n = f.named;
  const r: string[] = [];
  const hm = f.profile.headerMatches[field];
  if (hm && hm.score >= 0.6) {
    r.push(hm.score >= 0.99 ? `Header matches "${hm.synonym}" (${hm.language})` : `Header resembles "${hm.synonym}" (${hm.language}, ${pct(hm.score)})`);
  }
  const add = (cond: boolean, text: string) => cond && r.push(text);
  add(n.isin_valid > 0.5, `${pct(n.isin_valid)} valid ISINs (checksum OK)`);
  add(n.lei_valid > 0.5, `${pct(n.lei_valid)} valid LEIs (ISO 17442 checksum)`);
  add(n.currency > 0.5, `${pct(n.currency)} ISO 4217 currency codes`);
  add(n.country > 0.5, `${pct(n.country)} ISO 3166 country codes`);
  add(n.cic > 0.5, `${pct(n.cic)} valid CIC codes`);
  add(n.rating > 0.5, `${pct(n.rating)} look like credit ratings`);
  add(n.date > 0.5, `${pct(n.date)} dates${n.date_spread > 0.3 ? ', spread over several years' : n.date_unique < 0.2 ? ', mostly the same date' : ''}`);
  add(n.sum_100 === 1, 'Values sum to ~100');
  add(n.sum_1 === 1, 'Values sum to ~1');
  add(n.share_of_other > 0.7, `Equals another column ÷ its total (${pct(n.share_of_other)} of rows)`);
  add(n.product_of_others > 0.7, `Equals the product of two other columns (${pct(n.product_of_others)} of rows)`);
  add(n.factor_of_product > 0.7, 'Multiplies with another column to give a third');
  add(n.row_id > 0.8, 'Runs 1, 2, 3, … (row numbers)');
  add(n.asset_kw > 0.5, `${pct(n.asset_kw)} asset-type words`);
  add(n.name_like > 0.6 && n.text > 0.8, 'Free-text names');
  add(n.in_50_150 > 0.7 && n.numeric > 0.8, 'Values mostly between 50 and 150 (bond-price-like)');
  add(n.in_0_20 > 0.8 && n.numeric > 0.8 && n.integer < 0.5, 'Small decimals (0–20)');
  add(n.hdr_ccy_token === 1, 'Header names a currency');
  add(n.hdr_local_token === 1, 'Header says local/instrument currency');
  add(n.hdr_base_token === 1, 'Header says base/portfolio/fund currency');
  add(n.fill < 0.3, `Only ${pct(n.fill)} of rows filled`);
  if (!r.length) r.push('No strong signal; based on the overall pattern of values');
  return r.slice(0, 5);
}

/**
 * Classify all columns. Fields other than `ignore` are assigned to at most one
 * column: the most confident claim wins and other columns fall back to their
 * next-best field. `fixed` lets callers pin mappings (from a profile or user).
 */
export function classifyColumns(
  columns: ColumnInput[],
  fixed: Map<number, { field: CanonicalField; source: MappingSource }> = new Map(),
): ColumnPrediction[] {
  const feats = extractFeatures(columns);
  const headerDecides = new Set<number>();
  const probs = feats.map((f, index) => {
    let p = predictProba(f.vector);
    const exact = headerOnlyField(columns[index], f);
    const ei = exact === undefined ? -1 : model.classes.indexOf(exact);
    if (ei >= 0 && p[ei] < HEADER_ONLY_P) {
      p = withFloor(p, ei, HEADER_ONLY_P);
      headerDecides.add(index);
    }
    return p;
  });

  // Relations between the columns' numbers: evidence the model cannot see column by column.
  const ccyCol = feats.findIndex((f) => (f.named.currency ?? 0) >= 0.8);
  const rel = findRelations(
    feats.map((f) => f.profile.numbers),
    ccyCol >= 0 ? columns[ccyCol].values.map((v) => (v == null ? undefined : String(v).trim().toUpperCase())) : undefined,
  );
  const priceIdx = model.classes.indexOf('price');
  const evidence = relationEvidence(rel, columns.map((c) => c.header), (col) => probs[col][priceIdx]);
  const boosted = new Map<number, string[]>();
  probs.forEach((p, i) => {
    const ev = evidence[i];
    if (!ev.bonus.size || fixed.has(i)) return;
    const w = p.map((x, k) => x * Math.exp(ev.bonus.get(model.classes[k] as CanonicalField) ?? 0));
    const sum = w.reduce((a, b) => a + b, 0);
    probs[i] = w.map((x) => x / sum);
    boosted.set(i, ev.reasons);
  });

  const preds: ColumnPrediction[] = feats.map((f, index) => ({
    index,
    header: columns[index].header,
    ranked: model.classes.map((c, i) => ({ field: c as CanonicalField, p: probs[index][i] })).sort((a, b) => b.p - a.p),
    field: 'ignore',
    confidence: 0,
    source: 'model',
    reasons: [],
    decimal: f.profile.decimal,
    features: f,
  }));

  const taken = new Set<CanonicalField>();
  for (const [i, m] of fixed) {
    if (!preds[i]) continue;
    preds[i].field = m.field;
    preds[i].confidence = 1;
    preds[i].source = m.source;
    if (UNIQUE_FIELDS.has(m.field)) taken.add(m.field);
  }

  // All free columns at once: the assignment with the highest joint probability, each field to at
  // most one column ("ignore" to any number), no field below MIN_CLAIM. Greedy claiming could give a
  // column's best field to a slightly more confident column even when that cost the table more.
  const free = preds.filter((p) => !fixed.has(p.index));
  const fields = model.classes.filter((c) => c !== 'ignore' && !taken.has(c as CanonicalField)) as CanonicalField[];
  if (free.length) {
    const BIG = 1e6;
    const ignoreIdx = model.classes.indexOf('ignore');
    const cost = free.map((pr) => {
      const p = probs[pr.index];
      const row = fields.map((f) => {
        const x = p[model.classes.indexOf(f)];
        return x < MIN_CLAIM ? BIG : -Math.log(x);
      });
      const ign = -Math.log(Math.max(p[ignoreIdx], 1e-12));
      return [...row, ...free.map(() => ign)];
    });
    const assignment = hungarian(cost);
    free.forEach((pr, r) => {
      const j = assignment[r];
      if (j >= 0 && j < fields.length && cost[r][j] < BIG) {
        pr.field = fields[j];
        pr.confidence = probs[pr.index][model.classes.indexOf(fields[j])];
      } else {
        // Nothing fits well enough: ignored, with the model's own probability for "ignore".
        pr.field = 'ignore';
        pr.confidence = probs[pr.index][ignoreIdx];
      }
    });
  }
  for (const p of preds) {
    p.reasons = p.source === 'model' ? explain(p.features, p.field) : [p.source === 'profile' ? 'From saved source profile' : 'Set by you'];
    const rel = boosted.get(p.index);
    if (p.source === 'model' && rel && p.field !== 'ignore') p.reasons.unshift(...rel.filter((r) => fieldInReason(r, p.field)));
    if (p.source === 'model' && headerDecides.has(p.index) && p.field === p.ranked[0].field) {
      p.reasons.unshift('Too few values to judge by: the header decides (check it)');
    }
    if (p.source === 'model' && p.field !== p.ranked[0].field) {
      p.reasons.unshift(`Best guess was ${CANONICAL_INFO[p.ranked[0].field].label}, but another column matched it better`);
    }
  }
  return preds;
}

/** Whether a relation reason supports the field the column got (so only relevant reasons are shown). */
function fieldInReason(reason: string, field: CanonicalField): boolean {
  if (field === 'price') return /: a price$/.test(reason);
  if (field === 'weight') return /: a weight$/.test(reason);
  if (field === 'quantity' || field === 'nominal' || field === 'amount_mixed') return /: a holding amount$/.test(reason);
  if (field === 'market_value_local') return /: a market value$|local-currency value$/.test(reason);
  if (field === 'market_value_portfolio') return /: a market value$|portfolio-currency value$/.test(reason);
  return false;
}

/**
 * Minimum-cost assignment of n rows to m ≥ n columns (Hungarian algorithm, O(n²m)). Returns the
 * column given to each row.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}
