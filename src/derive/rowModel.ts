/**
 * The row asset-class model: gradient-boosted trees over one row's features (rowFeatures.ts),
 * trained on synthetic holdings (scripts/row-training.ts, training/train_rows.py) and calibrated.
 *
 * It only speaks where the rules are unsure. An asset-type text in the file or a telling keyword in
 * the name ("Call", "FRN", "UCITS ETF") decides as before; a row with neither ("ERIC B 70C" with a
 * strike and a delta, "FESX Z6" with a contract size) gets the model's reading, flagged for review.
 */
import rowModelJson from './rowModel.json';
import { treeProba, type TreeModel } from '../ml/trees.ts';
import { ROW_FEATURE_NAMES, rowFeatures, type RowInput } from './rowFeatures.ts';
import { ROW_CLASSES, ROW_CLASS_LABEL, type RowClass } from './rowClasses.ts';

export const rowModel = rowModelJson as unknown as TreeModel & { metrics: Record<string, unknown>; trainedAt: string };

if (rowModel.featureNames.length !== ROW_FEATURE_NAMES.length || rowModel.featureNames.some((n, i) => n !== ROW_FEATURE_NAMES[i])) {
  throw new Error('rowModel.json was trained with a different feature set. Retrain it (training/train_rows.py).');
}
if (rowModel.classes.some((c, i) => c !== ROW_CLASSES[i])) throw new Error('rowModel.json classes differ from rowClasses.ts.');

export interface RowPrediction {
  cls: RowClass;
  p: number;
  ranked: { cls: RowClass; p: number }[];
  /** The row's own evidence the model had, in words. */
  why: string[];
}

export function predictRow(f: RowInput, valuationDate?: string): RowPrediction {
  const x = rowFeatures(f, valuationDate);
  const p = treeProba(rowModel, x);
  const ranked = ROW_CLASSES.map((cls, i) => ({ cls, p: p[i] })).sort((a, b) => b.p - a.p);
  return { cls: ranked[0].cls, p: ranked[0].p, ranked, why: evidenceOf(f) };
}

/** What the row carries that a reader would point to, for the explanation. */
function evidenceOf(f: RowInput): string[] {
  const out: string[] = [];
  if (f.strike !== undefined) out.push(`strike ${f.strike}`);
  if (f.call_put) out.push(`"${f.call_put}" in the call/put column`);
  if (f.delta !== undefined) out.push(`delta ${f.delta}`);
  if (f.contract_size !== undefined) out.push(`contract size ${f.contract_size}`);
  if (f.underlying_name) out.push(`underlying ${f.underlying_name}`);
  if (f.coupon !== undefined) out.push(`coupon ${f.coupon}`);
  if (f.maturity_date) out.push(`maturity ${f.maturity_date}`);
  if (f.nominal !== undefined) out.push('a nominal amount');
  if (f.price !== undefined) out.push(`price ${f.price}`);
  if (f.isin) out.push(`ISIN ${f.isin.slice(0, 2)}…`);
  if (f.security_name) out.push(`the name "${f.security_name}"`);
  return out.slice(0, 5);
}

export const rowClassLabel = (c: RowClass) => ROW_CLASS_LABEL[c];
