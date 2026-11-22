"""
Train the row asset-class model: gradient-boosted trees over one holding row's features
(src/derive/rowFeatures.ts), calibrated with a temperature fitted on held-out tables, exported to
src/derive/rowModel.json for the same TypeScript tree inference the column classifier uses.

The app uses it only where the rules are unsure (no asset-type text, no telling keyword), so the
figures printed here are also reported for the rows the rules alone cannot place.

Usage:  python training/train_rows.py training/data/rows.jsonl src/derive/rowModel.json
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path

import lightgbm as lgb
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train import compact_threshold, ece, fit_temperature, softmax  # noqa: E402

PARAMS = {
    "objective": "multiclass",
    "num_leaves": 7,
    "learning_rate": 0.15,
    "min_data_in_leaf": 40,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.85,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "verbose": -1,
    "seed": 11,
    "num_threads": 0,
}
MAX_ROUNDS = 120


def load(path: Path):
    with path.open() as f:
        head = json.loads(f.readline())
        X, y, g = [], [], []
        for line in f:
            r = json.loads(line)
            X.append(r["x"])
            y.append(head["classes"].index(r["label"]))
            g.append(r["table"])
    return head["featureNames"], head["classes"], np.array(X, dtype=np.float64), np.array(y), np.array(g)


def flatten(tree, uniq):
    f, t, l, r = [], [], [], []

    def walk(node):
        i = len(f)
        f.append(-1); t.append(0.0); l.append(-1); r.append(-1)
        if "leaf_value" in node:
            t[i] = round(float(node["leaf_value"]), 5)
            return i
        assert node["decision_type"] == "<=", node["decision_type"]
        f[i] = int(node["split_feature"])
        t[i] = compact_threshold(float(node["threshold"]), uniq[f[i]])
        l[i] = walk(node["left_child"])
        r[i] = walk(node["right_child"])
        return i

    walk(tree)
    return {"f": f, "t": t, "l": l, "r": r}


def raw_from_json(trees, k, X):
    out = np.zeros((X.shape[0], k))
    for j, tr in enumerate(trees):
        for n in range(X.shape[0]):
            i = 0
            while tr["f"][i] >= 0:
                i = tr["l"][i] if X[n, tr["f"][i]] <= tr["t"][i] else tr["r"][i]
            out[n, j % k] += tr["t"][i]
    return out


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "training/data/rows.jsonl")
    dst = Path(sys.argv[2] if len(sys.argv) > 2 else "src/derive/rowModel.json")
    names, classes, X, y, g = load(src)
    k = len(classes)
    print(f"Loaded {len(y)} rows, {X.shape[1]} features, {len(set(g))} tables, {k} classes")
    rng = np.random.default_rng(42)
    tables = np.unique(g)
    val_tables = set(rng.choice(tables, size=max(1, len(tables) // 6), replace=False).tolist())
    val = np.array([t in val_tables for t in g])
    params = {**PARAMS, "num_class": k}

    booster = lgb.train(params, lgb.Dataset(X[~val], y[~val]), MAX_ROUNDS, valid_sets=[lgb.Dataset(X[val], y[val])], callbacks=[lgb.early_stopping(15, verbose=False)])
    rounds = booster.best_iteration or MAX_ROUNDS
    raw = booster.predict(X[val], num_iteration=rounds, raw_score=True)
    T = fit_temperature(raw, y[val])
    P = softmax(raw / T)
    pred = P.argmax(axis=1)
    acc = float((pred == y[val]).mean())
    hi = P.max(axis=1) >= 0.8
    print(f"validation: accuracy {acc:.4f}; >=80% confident: {hi.mean():.3f} of rows, accuracy there {(pred[hi] == y[val][hi]).mean():.4f}; ECE {ece(softmax(raw), y[val]):.4f} -> {ece(P, y[val]):.4f} (T={T:.2f}, {rounds} rounds)")
    for (a, p), n in Counter((classes[a], classes[p]) for a, p in zip(y[val], pred) if a != p).most_common(10):
        print(f"    {a:>15} -> {p:<15} {n}")
    per = {}
    for c in range(k):
        m = y[val] == c
        tp = int(((pred == c) & m).sum()); fp = int(((pred == c) & ~m).sum())
        per[classes[c]] = {"support": int(m.sum()), "recall": round(tp / max(1, m.sum()), 4), "precision": round(tp / (tp + fp), 4) if tp + fp else 0.0}

    final = lgb.train(params, lgb.Dataset(X, y), rounds)
    uniq = [np.unique(X[:, j]) for j in range(X.shape[1])]
    trees = [flatten(t["tree_structure"], uniq) for t in final.dump_model()["tree_info"]]
    sample = X[:: max(1, len(X) // 400)][:400]
    diff = np.abs(raw_from_json(trees, k, sample) - final.predict(sample, raw_score=True)).max()
    print(f"export check: max |raw score difference| = {diff:.2e}")
    assert diff < 1e-3, "exported trees do not reproduce LightGBM"
    model = {
        "type": "gradient-boosted-trees",
        "trainedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "featureNames": names,
        "classes": classes,
        "temperature": round(T, 4),
        "trees": trees,
        "metrics": {
            "trainRows": int((~val).sum()),
            "validationRows": int(val.sum()),
            "rounds": int(rounds),
            "validationAccuracy": round(acc, 4),
            "validationHighConfidenceShare": round(float(hi.mean()), 4),
            "validationHighConfidenceAccuracy": round(float((pred[hi] == y[val][hi]).mean()), 4),
            "calibrationErrorAfter": round(ece(P, y[val]), 4),
            "validationPerClass": per,
        },
    }
    dst.write_text(json.dumps(model, separators=(",", ":")) + "\n")
    print(f"Wrote {dst} ({dst.stat().st_size / 1e3:.0f} kB, {len(trees)} trees)")


if __name__ == "__main__":
    main()
