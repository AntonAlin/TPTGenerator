// Dev helper: print table detection and column mapping for every file in /samples.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWorkbook } from '../src/ingest/readFile.ts';
import { detectTable } from '../src/ingest/table.ts';
import { classifyColumns } from '../src/detect/classify.ts';
const dir = resolve(import.meta.dirname, '../samples');
for (const f of readdirSync(dir).filter((x) => /\.(xlsx|xls|csv)$/.test(x))) {
  const wb = readWorkbook(new Uint8Array(readFileSync(`${dir}/${f}`)), f);
  const t = detectTable(wb.sheets[0].rows);
  console.log(`\n== ${f}: ${wb.notes.join(' ')} header rows ${t.headerRows.map((r) => r + 1)}; ${t.rows.length} rows; skipped ${t.skipped.map((s) => `${s.row + 1}:${s.reason}`).join(', ')}`);
  const preds = classifyColumns(t.headers.map((h, i) => ({ header: h, values: t.rows.map((r) => r.cells[i]) })));
  for (const p of preds) console.log(`  ${p.header.padEnd(36)} → ${p.field.padEnd(24)} ${(p.confidence * 100).toFixed(0)}%`);
}
