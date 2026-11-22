/**
 * The matching benchmark: every layout × n seeds, scored field by field.
 *
 *   npm run bench -- [seedsPerLayout=5] [firstSeed=1] [layoutId…]
 *
 * Prints accuracy per check and per layout, the worst failures, and writes the summary to
 * bench-results/summary.json. tests/bench.test.ts runs a small version on every test run and
 * fails when a figure drops below bench/thresholds.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAYOUTS } from './layouts.ts';
import { renderCase } from './render.ts';
import { CHECKS, evaluateCase, type CaseResult, type Check } from './evaluate.ts';

export interface BenchSummary {
  files: number;
  mapping: number;
  checks: Partial<Record<Check, number>>;
  layouts: Record<string, { mapping: number; holdingsAllRight: number; files: number }>;
  results: CaseResult[];
}

export function runBench(seedsPerLayout: number, firstSeed: number, outDir: string, only: string[] = []): BenchSummary {
  const results: CaseResult[] = [];
  for (const layout of LAYOUTS.filter((l) => !only.length || only.includes(l.id))) {
    for (let s = firstSeed; s < firstSeed + seedsPerLayout; s++) results.push(evaluateCase(renderCase(layout, s, outDir)));
  }
  const sum = (k: Check) => results.reduce((acc, r) => [acc[0] + (r.checks[k]?.[0] ?? 0), acc[1] + (r.checks[k]?.[1] ?? 0)], [0, 0]);
  const checks: BenchSummary['checks'] = {};
  for (const k of CHECKS) {
    const [a, n] = sum(k);
    if (n) checks[k] = a / n;
  }
  const mapAll = results.flatMap((r) => r.mapping);
  const layouts: BenchSummary['layouts'] = {};
  for (const r of results) {
    const l = (layouts[r.layout] ??= { mapping: 0, holdingsAllRight: 0, files: 0 });
    l.files++;
    l.mapping += r.mapping.filter((m) => m.ok).length / r.mapping.length;
    l.holdingsAllRight += r.failures.length ? 0 : 1;
  }
  for (const l of Object.values(layouts)) {
    l.mapping /= l.files;
    l.holdingsAllRight /= l.files;
  }
  return { files: results.length, mapping: mapAll.filter((m) => m.ok).length / mapAll.length, checks, layouts, results };
}

function main() {
  const [n = '5', first = '1', ...only] = process.argv.slice(2);
  const outDir = resolve('bench-results');
  mkdirSync(outDir, { recursive: true });
  const s = runBench(Number(n), Number(first), resolve(outDir, 'files'), only);
  const pct = (x: number | undefined) => (x === undefined ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)}%`);
  console.log(`\nMatching benchmark: ${s.files} files, ${Object.keys(s.layouts).length} layouts\n`);
  console.log(`  column mapping            ${pct(s.mapping)}`);
  for (const k of CHECKS) console.log(`  ${k.padEnd(24)}  ${pct(s.checks[k])}`);
  console.log('\nPer layout (mapping · files with every check right):');
  for (const [id, l] of Object.entries(s.layouts)) console.log(`  ${id.padEnd(22)} ${pct(l.mapping)} · ${pct(l.holdingsAllRight)}`);
  const wrongMaps = s.results.flatMap((r) => r.mapping.filter((m) => !m.ok).map((m) => `${r.layout}: "${m.header}" → ${m.got} (want ${m.expect})`));
  const uniq = [...new Set(wrongMaps)];
  if (uniq.length) console.log(`\nWrong mappings (${uniq.length} distinct):\n  ${uniq.slice(0, 30).join('\n  ')}`);
  const fails = s.results.flatMap((r) => r.failures.map((f) => `${r.file}: ${f}`));
  if (fails.length) console.log(`\nFailures (${fails.length}, first 40):\n  ${fails.slice(0, 40).join('\n  ')}`);
  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify({ ...s, results: undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
