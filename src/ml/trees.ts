/**
 * Inference for gradient-boosted decision trees exported by training/*.py: flat arrays per tree,
 * tree k adding to class k mod classes, scores divided by a temperature fitted on held-out data,
 * then softmax. Shared by the column classifier and the row asset-class model.
 */

/** One tree: split feature (-1 for a leaf), threshold or leaf value, left and right child. */
export interface Tree {
  f: number[];
  t: number[];
  l: number[];
  r: number[];
}

export interface TreeModel {
  featureNames: string[];
  classes: string[];
  trees: Tree[];
  temperature?: number;
}

export function softmax(z: number[]): number[] {
  const max = Math.max(...z);
  const e = z.map((v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** Raw class scores: the sum of each class's trees at x. */
export function treeScores(m: Pick<TreeModel, 'classes' | 'trees'>, x: number[]): number[] {
  const k = m.classes.length;
  const z = new Array<number>(k).fill(0);
  for (let i = 0; i < m.trees.length; i++) {
    const tr = m.trees[i];
    let n = 0;
    while (tr.f[n] >= 0) n = x[tr.f[n]] <= tr.t[n] ? tr.l[n] : tr.r[n];
    z[i % k] += tr.t[n];
  }
  return z;
}

/** Calibrated probabilities: the temperature fitted on held-out data, so 60% means right about 60% of the time. */
export function treeProba(m: TreeModel, x: number[]): number[] {
  const T = m.temperature ?? 1;
  return softmax(treeScores(m, x).map((v) => v / T));
}
