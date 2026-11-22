#!/usr/bin/env bash
# Retrain the column classifier end to end:
#   1. generate synthetic messy tables (Python)
#   2. extract features with the app's own TypeScript code (Node), in JOBS parallel parts
#   3. train gradient-boosted trees, calibrate, export src/detect/model.json (Python + LightGBM)
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-training/.venv/bin/python}"
TABLES="${TABLES:-4000}"
SEED="${SEED:-7}"
JOBS="${JOBS:-4}"
D=training/data
"$PY" training/generate.py --tables "$TABLES" --seed "$SEED" --out "$D/tables.jsonl"
# Feature extraction is one table at a time; split the tables so every core works on a part.
rm -f "$D"/tables.part.* "$D"/features.part.*
split -n "l/$JOBS" -d "$D/tables.jsonl" "$D/tables.part."
for part in "$D"/tables.part.*; do
  npx tsx scripts/extract-features.ts "$part" "${part/tables.part/features.part}" &
done
wait
# One header line (the feature names), then every part's rows.
head -n 1 "$D/features.part.00" > "$D/features.jsonl"
for part in "$D"/features.part.*; do tail -n +2 "$part" >> "$D/features.jsonl"; done
rm -f "$D"/tables.part.* "$D"/features.part.*
"$PY" training/train.py "$D/features.jsonl" src/detect/model.json
