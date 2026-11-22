"""
Train the column classifier: gradient-boosted decision trees (LightGBM, multiclass), calibrated
with a temperature fitted on held-out tables, and exported to compact JSON for TypeScript
inference (src/detect/model.json). The previous model, multinomial logistic regression, is trained
on the same split for comparison.

The split is by table: no column of a validation table is ever seen in training, so the
validation figures are what a new file gets.

Usage:  python training/train.py training/data/features.jsonl src/detect/model.json [--reuse]
        (--reuse exports the last trained model again without training)
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from collections import Counter
from pathlib import Path

import lightgbm as lgb
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
# The class list is the app's own field list, in the same order (src/detect/canonical.ts).
CLASSES = re.findall(r"'([a-z0-9_]+)'", re.search(r"CANONICAL_FIELDS = \[(.*?)\] as const", (ROOT / "src/detect/canonical.ts").read_text(), re.S).group(1))

PARAMS = {
    "objective": "multiclass",
    "num_class": len(CLASSES),
    "num_leaves": 7,
    "learning_rate": 0.15,
    # Regularised on purpose: the training tables are synthetic, and a tree that splits on a quirk
    # of the generator (every price column full) fails on real files.
    "min_data_in_leaf": 60,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.85,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "verbose": -1,
    "seed": 7,
    "num_threads": 0,
}
MAX_ROUNDS = 160


def load(path: Path):
    with path.open() as f:
        names = json.loads(f.readline())["featureNames"]
        X, y, g = [], [], []
        for line in f:
            r = json.loads(line)
            X.append(r["x"])
            y.append(CLASSES.index(r["label"]))
            g.append(r["table"])
    return names, np.array(X, dtype=np.float64), np.array(y), np.array(g)


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def train_lr(X, y, sw, l2=1e-3, epochs=1500, lr=0.05):
    """The previous model (softmax regression, Adam), kept as the baseline to beat."""
    rng = np.random.default_rng(0)
    n, d = X.shape
    k = len(CLASSES)
    W = rng.normal(0, 0.01, (d, k)); b = np.zeros(k); Y = np.eye(k)[y]
    sw = sw / sw.mean()
    mW = np.zeros_like(W); vW = np.zeros_like(W); mb = np.zeros_like(b); vb = np.zeros_like(b)
    for t in range(1, epochs + 1):
        P = softmax(X @ W + b)
        G = (P - Y) * sw[:, None] / n
        gW = X.T @ G + l2 * W; gb = G.sum(axis=0)
        mW = 0.9 * mW + 0.1 * gW; vW = 0.999 * vW + 0.001 * gW**2
        mb = 0.9 * mb + 0.1 * gb; vb = 0.999 * vb + 0.001 * gb**2
        W -= lr * (mW / (1 - 0.9**t)) / (np.sqrt(vW / (1 - 0.999**t)) + 1e-8)
        b -= lr * (mb / (1 - 0.9**t)) / (np.sqrt(vb / (1 - 0.999**t)) + 1e-8)
    return lambda Z: softmax(Z @ W + b)


def ece(P, y, bins=15):
    """Expected calibration error: how far confidence is from accuracy, weighted by bin size."""
    conf = P.max(axis=1); pred = P.argmax(axis=1); total = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.any():
            total += m.mean() * abs((pred[m] == y[m]).mean() - conf[m].mean())
    return float(total)


def fit_temperature(raw, y):
    """The temperature T minimising the log loss of softmax(raw / T) on held-out data."""
    best = (1.0, 1e18)
    for T in np.concatenate([np.linspace(0.3, 3.0, 271)]):
        P = softmax(raw / T)
        nll = -np.mean(np.log(P[np.arange(len(y)), y] + 1e-12))
        if nll < best[1]:
            best = (float(T), nll)
    return best[0]


def report(name, P, y):
    pred = P.argmax(axis=1)
    acc = float((pred == y).mean())
    per = {}
    for c in range(len(CLASSES)):
        m = y == c
        if m.sum():
            tp = int(((pred == c) & m).sum()); fp = int(((pred == c) & ~m).sum())
            per[CLASSES[c]] = {"support": int(m.sum()), "recall": round(tp / m.sum(), 4), "precision": round(tp / (tp + fp), 4) if tp + fp else 0.0}
    hi = P.max(axis=1) >= 0.6
    hi_acc = float((pred[hi] == y[hi]).mean()) if hi.any() else 0.0
    print(f"{name}: accuracy {acc:.4f}; >=60% confident: {hi.mean():.3f} of columns, accuracy there {hi_acc:.4f}; ECE {ece(P, y):.4f}")
    for (a, p), n in Counter((CLASSES[a], CLASSES[p]) for a, p in zip(y, pred) if a != p).most_common(8):
        print(f"    {a:>24} -> {p:<24} {n}")
    return {"acc": acc, "per": per, "hiShare": float(hi.mean()), "hiAcc": hi_acc, "ece": ece(P, y)}


def compact_threshold(t, values):
    """
    The shortest decimal that splits the training values exactly as LightGBM's threshold does.

    LightGBM's thresholds are long doubles; rounding them blindly to a fixed number of decimals
    flips rows whose value sits between the rounded and the true threshold (a feature of exactly
    0.5 against a threshold of 0.49999999). The shortest number in [largest value <= t, smallest
    value > t) keeps every training decision and keeps the JSON small.
    """
    i = np.searchsorted(values, t, side="right")
    lo = values[i - 1] if i > 0 else -np.inf
    hi = values[i] if i < len(values) else np.inf
    for digits in range(1, 18):
        for d in (float(f"{t:.{digits}g}"), float(f"{(lo + hi) / 2 if np.isfinite(lo + hi) else t:.{digits}g}")):
            if lo <= d < hi:
                return d
    return float(t)


def flatten(tree, uniq):
    """A LightGBM tree as flat arrays: split feature (-1 for a leaf), threshold or leaf value, children."""
    f, t, l, r = [], [], [], []

    def walk(node):
        i = len(f)
        f.append(-1); t.append(0.0); l.append(-1); r.append(-1)
        if "leaf_value" in node:
            t[i] = round(float(node["leaf_value"]), 5)
            return i
        assert node["decision_type"] == "<=", node["decision_type"]
        # No missing values in the features: a NaN branch would be a feature bug.
        assert node.get("missing_type", "None") in ("None", "NaN"), node.get("missing_type")
        f[i] = int(node["split_feature"])
        t[i] = compact_threshold(float(node["threshold"]), uniq[f[i]])
        l[i] = walk(node["left_child"])
        r[i] = walk(node["right_child"])
        return i

    walk(tree)
    return {"f": f, "t": t, "l": l, "r": r}


def raw_from_json(trees, X):
    """Inference exactly as the app does it, to check the export."""
    out = np.zeros((X.shape[0], len(CLASSES)))
    for k, tr in enumerate(trees):
        c = k % len(CLASSES)
        for n in range(X.shape[0]):
            i = 0
            while tr["f"][i] >= 0:
                i = tr["l"][i] if X[n, tr["f"][i]] <= tr["t"][i] else tr["r"][i]
            out[n, c] += tr["t"][i]
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    src = Path(args[0] if args else "training/data/features.jsonl")
    dst = Path(args[1] if len(args) > 1 else "src/detect/model.json")
    names, X, y, g = load(src)
    cache = src.with_name("booster.txt")
    cache_meta = src.with_name("booster.json")
    if "--reuse" in sys.argv and cache.exists() and cache_meta.exists():
        m = json.loads(cache_meta.read_text())
        print(f"Reusing {cache} ({m['rounds']} rounds, temperature {m['T']:.3f})")
        export(lgb.Booster(model_file=str(cache)), names, X, dst, m["rounds"], m["T"], m["base"], m["uncal"], m["cal"], m["train"], m["val"])
        return
    print(f"Loaded {len(y)} columns, {X.shape[1]} features, {len(set(g))} tables, {len(CLASSES)} classes")
    tables = np.unique(g)
    rng = np.random.default_rng(42)
    val_tables = set(rng.choice(tables, size=max(1, len(tables) // 6), replace=False).tolist())
    val = np.array([t in val_tables for t in g])
    counts = np.bincount(y, minlength=len(CLASSES)).astype(float)
    cw = np.where(counts > 0, (counts.sum() / np.maximum(counts, 1)) ** 0.5, 1.0)
    sw = cw[y] / cw[y].mean()

    print("\nBaseline: multinomial logistic regression (the previous model)")
    lr_predict = train_lr(X[~val], y[~val], sw[~val])
    base = report("validation (LR)", lr_predict(X[val]), y[val])

    print("\nGradient-boosted trees")
    dtrain = lgb.Dataset(X[~val], y[~val], weight=sw[~val])
    dval = lgb.Dataset(X[val], y[val], weight=sw[val], reference=dtrain)
    booster = lgb.train(PARAMS, dtrain, MAX_ROUNDS, valid_sets=[dval], callbacks=[lgb.early_stopping(15, verbose=False)])
    rounds = booster.best_iteration or MAX_ROUNDS
    raw_val = booster.predict(X[val], num_iteration=rounds, raw_score=True)
    T = fit_temperature(raw_val, y[val])
    uncal = report("validation (trees, uncalibrated)", softmax(raw_val), y[val])
    cal = report(f"validation (trees, temperature {T:.2f})", softmax(raw_val / T), y[val])
    print(f"rounds {rounds}, temperature {T:.3f}")

    # Final model on all data, same number of rounds and temperature. Kept next to the data so a
    # failed export does not cost another training run (--reuse).
    final = lgb.train(PARAMS, lgb.Dataset(X, y, weight=sw), rounds)
    final.save_model(str(cache))
    cache_meta.write_text(json.dumps({"rounds": int(rounds), "T": T, "base": base, "uncal": uncal, "cal": cal, "train": int((~val).sum()), "val": int(val.sum())}))
    export(final, names, X, dst, rounds, T, base, uncal, cal, int((~val).sum()), int(val.sum()))


def export(final, names, X, dst, rounds, T, base, uncal, cal, n_train, n_val):
    uniq = [np.unique(X[:, j]) for j in range(X.shape[1])]
    trees = [flatten(t["tree_structure"], uniq) for t in final.dump_model()["tree_info"]]
    # The export must reproduce LightGBM's own scores.
    sample = X[:: max(1, len(X) // 400)][:400]
    diff = np.abs(raw_from_json(trees, sample) - final.predict(sample, raw_score=True)).max()
    print(f"export check: max |raw score difference| on {len(sample)} columns = {diff:.2e}")
    assert diff < 1e-3, "exported trees do not reproduce LightGBM"

    model = {
        "type": "gradient-boosted-trees",
        "trainedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "featureNames": names,
        "classes": CLASSES,
        "temperature": round(T, 4),
        "trees": trees,
        "metrics": {
            "trainColumns": n_train,
            "validationColumns": n_val,
            "rounds": int(rounds),
            "validationAccuracy": round(cal["acc"], 4),
            "validationHighConfidenceShare": round(cal["hiShare"], 4),
            "validationHighConfidenceAccuracy": round(cal["hiAcc"], 4),
            "calibrationErrorBefore": round(uncal["ece"], 4),
            "calibrationErrorAfter": round(cal["ece"], 4),
            "baselineValidationAccuracy": round(base["acc"], 4),
            "validationPerClass": cal["per"],
        },
    }
    dst.write_text(json.dumps(model, separators=(",", ":")) + "\n")
    print(f"Wrote {dst} ({dst.stat().st_size / 1e6:.2f} MB, {len(trees)} trees)")


if __name__ == "__main__":
    main()
