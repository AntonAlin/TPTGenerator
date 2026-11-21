#!/usr/bin/env bash
# Retrain the column classifier end to end:
#   1. generate synthetic messy tables (Python)
#   2. extract features with the app's own TypeScript code (Node)
#   3. train softmax regression and export src/detect/model.json (Python + numpy)
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-training/.venv/bin/python}"
TABLES="${TABLES:-4000}"
SEED="${SEED:-7}"
"$PY" training/generate.py --tables "$TABLES" --seed "$SEED" --out training/data/tables.jsonl
npx tsx scripts/extract-features.ts training/data/tables.jsonl training/data/features.jsonl
"$PY" training/train.py training/data/features.jsonl src/detect/model.json
