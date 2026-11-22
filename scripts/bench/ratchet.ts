/**
 * Raise bench/thresholds.json to today's figures (minus a small margin) where they went up.
 * Never lowers a threshold.   npx tsx scripts/bench/ratchet.ts
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runBench } from './run.ts';

const file = resolve(import.meta.dirname, '../../bench/thresholds.json');
const t = JSON.parse(readFileSync(file, 'utf8'));
const dir = join(tmpdir(), `tpt-bench-ratchet-${process.pid}`);
const s = runBench(3, 101, dir);
rmSync(dir, { recursive: true, force: true });
const floor = (x: number) => Math.max(0, Math.floor((x - 0.005) * 1000) / 1000);
const up = (old: number | undefined, now: number) => Math.max(old ?? 0, floor(now));
const before = JSON.stringify(t);
t.mapping = up(t.mapping, s.mapping);
for (const [k, v] of Object.entries(s.checks)) t.checks[k] = up(t.checks[k], v!);
writeFileSync(file, JSON.stringify(t, null, 2) + '\n');
console.log(before === JSON.stringify(t) ? 'No threshold changed.' : 'Thresholds raised:', JSON.stringify({ mapping: t.mapping, ...t.checks }));
