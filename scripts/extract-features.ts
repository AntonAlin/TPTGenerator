/**
 * Training helper: turn synthetic tables (training/generate.py output) into
 * feature vectors using the SAME TypeScript feature code the browser uses.
 *
 *   npx tsx scripts/extract-features.ts training/data/tables.jsonl training/data/features.jsonl
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { extractFeatures, FEATURE_NAMES } from '../src/detect/features.ts';
import type { RawCell } from '../src/ingest/readFile.ts';

const [input = 'training/data/tables.jsonl', output = 'training/data/features.jsonl'] = process.argv.slice(2);

const toCell = (v: unknown): RawCell => {
  if (v && typeof v === 'object' && '$date' in v) return new Date(`${(v as { $date: string }).$date}T00:00:00Z`);
  return v as RawCell;
};

const out = createWriteStream(output);
out.write(`${JSON.stringify({ featureNames: FEATURE_NAMES })}\n`);
let tables = 0;
let columns = 0;
const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const t = JSON.parse(line) as { id: number; columns: { header: string; values: unknown[]; label: string }[] };
  const feats = extractFeatures(t.columns.map((c) => ({ header: c.header, values: c.values.map(toCell) })));
  feats.forEach((f, i) => {
    out.write(`${JSON.stringify({ table: t.id, label: t.columns[i].label, x: f.vector })}\n`);
    columns++;
  });
  tables++;
}
out.end();
console.log(`Extracted ${columns} columns from ${tables} tables (${FEATURE_NAMES.length} features) → ${output}`);
