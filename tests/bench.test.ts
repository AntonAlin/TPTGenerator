/**
 * The matching benchmark as a gate: every layout in scripts/bench/layouts.ts with three seeds,
 * scored field by field. A figure below bench/thresholds.json fails the build, so an improvement
 * in one place cannot quietly cost accuracy in another. `npm run bench` gives the full report.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBench } from '../scripts/bench/run.ts';
import thresholds from '../bench/thresholds.json' with { type: 'json' };

const dir = join(tmpdir(), `tpt-bench-${process.pid}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('matching benchmark', () => {
  const s = runBench(3, 101, dir);
  it('column mapping', () => expect(s.mapping).toBeGreaterThanOrEqual(thresholds.mapping));
  it.each(Object.entries(thresholds.checks))('%s', (check, min) => {
    expect(s.checks[check as keyof typeof s.checks] ?? 0, check).toBeGreaterThanOrEqual(min as number);
  });
});
