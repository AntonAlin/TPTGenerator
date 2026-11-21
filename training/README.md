# Column classifier training

Trains the logistic-regression model in `src/detect/model.json` that maps input columns to canonical fields.

```bash
python3 -m venv training/.venv
training/.venv/bin/pip install -r training/requirements.txt
training/retrain.sh                 # TABLES=4000 SEED=7 by default
npm test                            # the classifier and sample tests must still pass
```

| File | Role |
| --- | --- |
| `generate.py` | Synthetic messy holdings tables. Headers come partly from `src/detect/synonyms.json` and partly from a held-out vocabulary, with mutations (case, typos, `_`, currency suffixes, generic names). Values vary in format: decimal comma/point, thousands separators, %, many date formats, xlsx-style numbers and dates. Noise columns are labelled `ignore`. |
| `../scripts/extract-features.ts` | Feature extraction with the app's own TypeScript code (`src/detect/features.ts`), so training and inference cannot diverge. |
| `train.py` | Softmax regression with L2 and Adam, numpy only. Validation is split by table. Exports weights, classes, feature names and metrics. |
| `retrain.sh` | Runs the three steps. Generated data goes to `training/data/`, which git ignores. |

If you change `FEATURE_NAMES` in `src/detect/features.ts`, retrain. The app refuses a `model.json` built on a different feature list.
