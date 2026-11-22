/**
 * Column classification: a model over the column features (gradient-boosted trees, calibrated;
 * the earlier logistic regression is still understood), relations between columns, a joint
 * one-to-one assignment, confidence and human-readable reasons.
 */
import modelJson from './model.json';
import { CANONICAL_FIELDS, CANONICAL_INFO, UNIQUE_FIELDS, type CanonicalField } from './canonical.ts';
import { extractFeatures, FEATURE_NAMES, type ColumnFeatures, type ColumnInput } from './features.ts';
import { findRelations, relationEvidence } from './relations.ts';
import { headerKey, normalizeHeader } from './headerMatch.ts';
import { softmax, treeProba, type Tree } from '../ml/trees.ts';

interface Model {
  type?: 'multinomial-logistic-regression' | 'gradient-boosted-trees';
  featureNames: string[];
  classes: string[];
  /** Logistic regression. */
  weights?: number[][];
  bias?: number[];
  /** Gradient-boosted trees: tree k adds to class k mod classes; scores divided by the temperature. */
  trees?: Tree[];
  temperature?: number;
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
 * A sparse column (under 40% of rows filled: a "Market value override" with values only for the
 * derivatives, a "Strike" filled only for the options) gives the model little but its header, and
 * the few values look alike across fields (small numbers, a few rows). When that header is an exact
 * synonym of one field, the header decides: the field gets at least this probability, which still
 * leaves the mapping highlighted for review.
 */
const HEADER_ONLY_P = 0.55;
const SPARSE_FILL = 0.4;
function headerOnlyField(col: ColumnInput, f: ColumnFeatures): CanonicalField | undefined {
  const filled = col.values.filter((v) => v != null && !(typeof v === 'string' && !v.trim()));
  if (!col.values.length || filled.length / col.values.length >= SPARSE_FILL) return undefined;
  const exact = model.classes.filter((c) => (f.named[`hdr_${c}`] ?? 0) >= 0.97);
  return exact.length === 1 ? (exact[0] as CanonicalField) : undefined;
}
function withFloor(p: number[], i: number, floor: number): number[] {
  if (i < 0 || p[i] >= floor) return p;
  const rest = 1 - p[i];
  return p.map((x, k) => (k === i ? floor : rest > 0 ? (x * (1 - floor)) / rest : 0));
}

export type MappingSource = 'model' | 'profile' | 'user';

/** A header the user mapped by hand before (profiles/learned.ts), by normalised header. */
export interface LearnedHint {
  field: CanonicalField;
  times: number;
  sources: string[];
}
export interface ClassifyOptions {
  learned?: Map<string, LearnedHint>;
}

const EXPOSURE_RE = /\b(exposure|exponering|engagement|exposition|risikoposition)\b|\bdelta[ -]?adj|^exp\.?\s*(%|in\b|\()/i;

/**
 * Probability a learned header gives its field: high at once, higher when taught again. A floor,
 * not a certainty: another column can still win the field if it fits much better.
 */
export function learnedFloor(times: number): number {
  return times >= 3 ? 0.96 : times === 2 ? 0.92 : 0.85;
}

const NUMERIC_FIELDS = new Set<CanonicalField>([
  'quantity', 'nominal', 'market_value_local', 'market_value_portfolio', 'price', 'coupon', 'weight', 'accrued_interest', 'fx_rate', 'amount_mixed',
  'dirty_price', 'yield', 'modified_duration', 'spread', 'cqs', 'contract_size', 'strike', 'underlying_price', 'delta',
]);

/**
 * Whether a column's values can hold a field at all. A lesson learned on one file's "Värde" must
 * not turn another file's text column of the same name into a market value.
 */
export function valuesFit(field: CanonicalField, f: ColumnFeatures): boolean {
  if (field === 'ignore' || f.profile.nonEmpty < 2) return true;
  const s = f.profile.stats;
  if (NUMERIC_FIELDS.has(field)) return s.numeric >= 0.6;
  if (field === 'maturity_date' || field === 'call_date') return s.date >= 0.6;
  if (field === 'isin') return f.named.isin_valid >= 0.3;
  if (field === 'currency') return f.named.currency >= 0.5;
  if (field === 'issuer_lei' || field === 'group_lei') return f.named.lei_valid >= 0.3;
  return true;
}

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
  /** The field a header learned from the user's earlier corrections pointed to, when one applied. */
  learned?: CanonicalField;
}

function checkModel(m: Model) {
  if (m.featureNames.length !== FEATURE_NAMES.length || m.featureNames.some((n, i) => n !== FEATURE_NAMES[i])) {
    throw new Error('model.json was trained with a different feature set. Retrain the model (see README).');
  }
  for (const c of m.classes) if (!(CANONICAL_FIELDS as readonly string[]).includes(c)) throw new Error(`Unknown class ${c} in model.json`);
}
checkModel(model);

export function predictProba(x: number[], m: Model = model): number[] {
  if (m.trees) return treeProba({ featureNames: m.featureNames, classes: m.classes, trees: m.trees, temperature: m.temperature }, x);
  return softmax(m.weights!.map((w, c) => w.reduce((s, wi, i) => s + wi * x[i], m.bias![c])));
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
  opts: ClassifyOptions = {},
): ColumnPrediction[] {
  const feats = extractFeatures(columns);
  const headerDecides = new Set<number>();
  const learnedFor = learnedLookup(opts.learned);
  const learnedBy = new Map<number, { hint: LearnedHint; reason: string }>();
  const exposureCols = new Set<number>();
  const probs = feats.map((f, index) => {
    let p = predictProba(f.vector);
    const exact = headerOnlyField(columns[index], f);
    const ei = exact === undefined ? -1 : model.classes.indexOf(exact);
    if (ei >= 0 && p[ei] < HEADER_ONLY_P) {
      p = withFloor(p, ei, HEADER_ONLY_P);
      headerDecides.add(index);
    }
    // An exposure column (delta-adjusted, gross, "% NAV") is not a market value, a holding or a
    // notional: the converter computes exposure itself (fields 27, 28, 30) from what the row holds.
    if (EXPOSURE_RE.test(columns[index].header) && !fixed.has(index)) {
      const ii = model.classes.indexOf('ignore');
      if (p[ii] < 0.9) p = withFloor(p, ii, 0.9);
      exposureCols.add(index);
    }
    // The user's own lesson for this header outranks the dictionary and the model.
    const hint = fixed.has(index) ? undefined : learnedFor(columns[index].header);
    const li = hint ? model.classes.indexOf(hint.field) : -1;
    if (hint && li >= 0) {
      const label = CANONICAL_INFO[hint.field].label;
      if (valuesFit(hint.field, f)) {
        if (p[li] < learnedFloor(hint.times)) p = withFloor(p, li, learnedFloor(hint.times));
        const more = hint.times > 1 ? ` (taught ${hint.times} times)` : '';
        learnedBy.set(index, { hint, reason: `You mapped "${columns[index].header}" to ${label} before, in ${hint.sources[0] ?? 'an earlier file'}${more}` });
      } else {
        learnedBy.set(index, { hint, reason: `You mapped "${columns[index].header}" to ${label} before, but these values cannot be one, so that lesson was not used` });
      }
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
  // Which factor of amount × price = value is the price: the model's view, and then whole numbers
  // (holdings are mostly whole numbers, prices mostly not), for when the model sees two prices.
  const priceLike = (col: number) => {
    const whole = feats[col].named.integer ?? 0;
    return probs[col][priceIdx] + 0.4 * (1 - whole) - 0.2 * whole;
  };
  const evidence = relationEvidence(rel, columns.map((c) => c.header), priceLike);
  const boosted = new Map<number, string[]>();
  probs.forEach((p, i) => {
    const ev = evidence[i];
    if (!ev.bonus.size || fixed.has(i)) return;
    const w = p.map((x, k) => x * Math.exp(ev.bonus.get(model.classes[k] as CanonicalField) ?? 0));
    const sum = w.reduce((a, b) => a + b, 0);
    probs[i] = w.map((x) => x / sum);
    boosted.set(i, ev.reasons);
  });
  holdingFromProduct(probs, rel, fixed, priceLike);
  splitValuePair(probs, feats, rel, fixed, columns, boosted);
  singleValueInOneCurrency(probs, feats, fixed, columns, boosted);

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
    if (p.source === 'model' && exposureCols.has(p.index) && p.field === 'ignore') p.reasons.unshift('An exposure column: the TPT exposure (fields 27, 28, 30) is computed from what each row holds');
    const l = learnedBy.get(p.index);
    if (p.source === 'model' && l) {
      p.reasons.unshift(l.reason);
      if (p.field === l.hint.field) p.learned = l.hint.field;
    }
  }
  return preds;
}

/**
 * In amount × price = value, once one factor is clearly the price, the other is the holding amount,
 * however much its numbers look like something else (a short column of round quantities can look
 * like prices to the model). Its holding fields get at least HOLDING_FLOOR together, split as the
 * model split them. Not for a factor that is itself a value (local value × FX rate = portfolio value).
 */
const HOLDING_FLOOR = 0.7;
function holdingFromProduct(probs: number[][], rel: ReturnType<typeof findRelations>, fixed: Map<number, unknown>, priceLike: (col: number) => number) {
  const priceIdx = model.classes.indexOf('price');
  const H = (['quantity', 'nominal', 'amount_mixed'] as const).map((f) => model.classes.indexOf(f));
  const V = (['market_value_local', 'market_value_portfolio'] as const).map((f) => model.classes.indexOf(f));
  for (const p of rel.products) {
    if (p.support < 0.8) continue;
    const [price, amount] = priceLike(p.a) >= priceLike(p.b) ? [p.a, p.b] : [p.b, p.a];
    if (fixed.has(amount) || probs[price][priceIdx] < 0.5) continue;
    if (V.reduce((s, k) => s + probs[amount][k], 0) >= 0.5 || rel.fx.some((f) => f.local === amount || f.port === amount)) continue;
    const h = H.reduce((s, k) => s + probs[amount][k], 0);
    if (h >= HOLDING_FLOOR) continue;
    const share = h > 1e-9 ? H.map((k) => probs[amount][k] / h) : [1, 0, 0];
    const rest = 1 - h;
    for (let k = 0; k < probs[amount].length; k++) if (!H.includes(k)) probs[amount][k] *= (1 - HOLDING_FLOOR) / rest;
    H.forEach((k, j) => (probs[amount][k] = HOLDING_FLOOR * share[j]));
  }
}

/**
 * Two market value columns the model cannot tell apart ("Col6"/"Col7", or "Market Value Local" and
 * "Market Value USD" both read as local): one is the local value and the other the portfolio value.
 * Which one is which comes from the headers when one says local, else, when one rate per currency
 * converts one into the other, from the order (files put the local value first). The pair's
 * probability of being a value is kept; only how it splits between local and portfolio changes.
 */
function splitValuePair(
  probs: number[][],
  feats: ColumnFeatures[],
  rel: ReturnType<typeof findRelations>,
  fixed: Map<number, unknown>,
  columns: ColumnInput[],
  reasons: Map<number, string[]>,
) {
  const L = model.classes.indexOf('market_value_local');
  const P = model.classes.indexOf('market_value_portfolio');
  const valueP = (i: number) => probs[i][L] + probs[i][P];
  // One rate per currency between two columns makes both values, whatever else they look like
  // (a converted value is no unit count). Without it, both must look like values already.
  const fxPair = rel.fx.find((f) => f.support >= 0.8 && !fixed.has(f.local) && !fixed.has(f.port));
  const pair = fxPair
    ? [Math.min(fxPair.local, fxPair.port), Math.max(fxPair.local, fxPair.port)]
    : probs.map((_, i) => i).filter((i) => !fixed.has(i) && valueP(i) >= 0.8);
  if (pair.length !== 2) return;
  const [a, b] = pair;
  const topLocal = (i: number) => probs[i][L] >= probs[i][P];
  if (topLocal(a) !== topLocal(b) && valueP(a) >= 0.5 && valueP(b) >= 0.5) return;
  const localTok = (i: number) => (feats[i].named.hdr_local_token ?? 0) >= 1;
  let local: number;
  let why: string;
  if (localTok(a) !== localTok(b)) {
    local = localTok(a) ? a : b;
    why = `"${columns[local].header}" says local`;
  } else if (fxPair) {
    local = a;
    why = 'one rate per currency converts one into the other, and the local value comes first';
  } else return;
  for (const i of [a, b]) {
    const m = Math.max(valueP(i), fxPair ? 0.9 : 0);
    const rest = 1 - valueP(i);
    // Other fields shrink to make room, in proportion.
    if (rest > 0) for (let k = 0; k < probs[i].length; k++) if (k !== L && k !== P) probs[i][k] *= (1 - m) / rest;
    probs[i][L] = m * (i === local ? 0.8 : 0.2);
    probs[i][P] = m * (i === local ? 0.2 : 0.8);
    const r = `"${columns[a].header}" and "${columns[b].header}" are the same values in two currencies (${why}): ${i === local ? 'the local-currency value' : 'the portfolio-currency value'}`;
    reasons.set(i, [...(reasons.get(i) ?? []), r]);
  }
}

/**
 * One market value column whose header names a currency ("Market Value (EUR)") in a file whose rows
 * are in several currencies holds every row in that one currency: the portfolio-currency value, not
 * the local one (a local value is in each row's own currency).
 */
function singleValueInOneCurrency(probs: number[][], feats: ColumnFeatures[], fixed: Map<number, unknown>, columns: ColumnInput[], reasons: Map<number, string[]>) {
  const L = model.classes.indexOf('market_value_local');
  const P = model.classes.indexOf('market_value_portfolio');
  const values = probs.map((_, i) => i).filter((i) => probs[i][L] + probs[i][P] >= 0.8);
  if (values.length !== 1 || fixed.has(values[0])) return;
  const i = values[0];
  const n = feats[i].named;
  if (!n.hdr_ccy_token || n.hdr_local_token || probs[i][P] >= probs[i][L]) return;
  const ccyCol = feats.findIndex((f) => (f.named.currency ?? 0) >= 0.8);
  if (ccyCol < 0) return;
  const ccys = new Set(columns[ccyCol].values.filter((v) => typeof v === 'string' && v.trim()).map((v) => String(v).trim().toUpperCase()));
  if (ccys.size < 2) return;
  const m = probs[i][L] + probs[i][P];
  probs[i][L] = m * 0.2;
  probs[i][P] = m * 0.8;
  reasons.set(i, [
    ...(reasons.get(i) ?? []),
    `"${columns[i].header}" names one currency while the rows are in ${ccys.size} (${[...ccys].slice(0, 4).join(', ')}): the portfolio-currency value`,
  ]);
}

/** Lessons by exact header, then by header key (same header with another date in it), if unambiguous. */
function learnedLookup(learned?: Map<string, LearnedHint>): (header: string) => LearnedHint | undefined {
  if (!learned?.size) return () => undefined;
  const byKey = new Map<string, LearnedHint | null>();
  for (const [h, l] of learned) {
    const k = headerKey(h);
    byKey.set(k, byKey.has(k) ? null : l);
  }
  return (header) => learned.get(normalizeHeader(header)) ?? byKey.get(headerKey(header)) ?? undefined;
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
