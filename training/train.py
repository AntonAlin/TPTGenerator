"""
Train the column classifier: multinomial logistic regression (softmax) with L2
regularisation, implemented in numpy only, and export weights to JSON for
TypeScript inference (src/detect/model.json).

Usage:  python training/train.py training/data/features.jsonl src/detect/model.json
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

CLASSES = [
    "isin", "other_identifier", "security_name", "quantity", "nominal", "market_value_local",
    "market_value_portfolio", "price", "currency", "coupon", "maturity_date", "asset_type", "weight",
    "rating", "issuer_name", "issuer_lei", "country", "accrued_interest", "fx_rate", "cic", "ignore",
]


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


def train(X, y, l2=1e-3, epochs=1500, lr=0.05, class_weight=None, seed=0):
    rng = np.random.default_rng(seed)
    n, d = X.shape
    k = len(CLASSES)
    W = rng.normal(0, 0.01, (d, k))
    b = np.zeros(k)
    Y = np.eye(k)[y]
    sw = np.ones(n) if class_weight is None else class_weight[y]
    sw = sw / sw.mean()
    # Adam
    mW = np.zeros_like(W); vW = np.zeros_like(W); mb = np.zeros_like(b); vb = np.zeros_like(b)
    b1, b2, eps = 0.9, 0.999, 1e-8
    for t in range(1, epochs + 1):
        P = softmax(X @ W + b)
        G = (P - Y) * sw[:, None] / n
        gW = X.T @ G + l2 * W
        gb = G.sum(axis=0)
        mW = b1 * mW + (1 - b1) * gW; vW = b2 * vW + (1 - b2) * gW**2
        mb = b1 * mb + (1 - b1) * gb; vb = b2 * vb + (1 - b2) * gb**2
        W -= lr * (mW / (1 - b1**t)) / (np.sqrt(vW / (1 - b2**t)) + eps)
        b -= lr * (mb / (1 - b1**t)) / (np.sqrt(vb / (1 - b2**t)) + eps)
        if t % 300 == 0:
            loss = -np.mean(np.log(P[np.arange(n), y] + 1e-12))
            print(f"  epoch {t}: loss {loss:.4f}")
    return W, b


def report(name, X, y, W, b):
    P = softmax(X @ W + b)
    pred = P.argmax(axis=1)
    acc = float((pred == y).mean())
    per = {}
    for c in range(len(CLASSES)):
        m = y == c
        if m.sum():
            tp = int(((pred == c) & m).sum())
            fp = int(((pred == c) & ~m).sum())
            per[CLASSES[c]] = {
                "support": int(m.sum()),
                "recall": round(tp / m.sum(), 4),
                "precision": round(tp / (tp + fp), 4) if tp + fp else 0.0,
            }
    conf = P.max(axis=1)
    hi = conf >= 0.6
    print(f"{name}: accuracy {acc:.4f}; high-confidence (>=0.6) share {hi.mean():.3f}, accuracy there {(pred[hi] == y[hi]).mean():.4f}")
    confusions = Counter((CLASSES[a], CLASSES[p]) for a, p in zip(y, pred) if a != p).most_common(10)
    for (a, p), n in confusions:
        print(f"    {a:>24} -> {p:<24} {n}")
    return acc, per, float(hi.mean()), float((pred[hi] == y[hi]).mean()) if hi.any() else 0.0


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "training/data/features.jsonl")
    dst = Path(sys.argv[2] if len(sys.argv) > 2 else "src/detect/model.json")
    names, X, y, g = load(src)
    print(f"Loaded {len(y)} columns, {X.shape[1]} features, {len(set(g))} tables")
    tables = np.unique(g)
    rng = np.random.default_rng(42)
    val_tables = set(rng.choice(tables, size=max(1, len(tables) // 6), replace=False).tolist())
    val = np.array([t in val_tables for t in g])
    counts = np.bincount(y, minlength=len(CLASSES)).astype(float)
    cw = np.where(counts > 0, (counts.sum() / np.maximum(counts, 1)) ** 0.5, 1.0)

    W, b = train(X[~val], y[~val], class_weight=cw)
    tr = report("train", X[~val], y[~val], W, b)
    va = report("validation", X[val], y[val], W, b)

    # Final model on all data.
    W, b = train(X, y, class_weight=cw)
    model = {
        "type": "multinomial-logistic-regression",
        "trainedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "featureNames": names,
        "classes": CLASSES,
        "weights": [[round(float(W[f, c]), 5) for f in range(W.shape[0])] for c in range(len(CLASSES))],
        "bias": [round(float(v), 5) for v in b],
        "metrics": {
            "trainColumns": int((~val).sum()),
            "validationColumns": int(val.sum()),
            "trainAccuracy": round(tr[0], 4),
            "validationAccuracy": round(va[0], 4),
            "validationHighConfidenceShare": round(va[2], 4),
            "validationHighConfidenceAccuracy": round(va[3], 4),
            "validationPerClass": va[1],
        },
    }
    dst.write_text(json.dumps(model, indent=1) + "\n")
    print(f"Wrote {dst}")


if __name__ == "__main__":
    main()
