/**
 * Random messy portfolios with an answer key (scripts/random-portfolio.ts), run through the whole
 * pipeline on every test run. `npm run random -- <seed> <count>` runs larger batches by hand.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePortfolio } from '../scripts/random-portfolio.ts';
import { evaluate } from '../scripts/evaluate-portfolio.ts';

const dir = mkdtempSync(join(tmpdir(), 'tpt-random-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('random portfolios', () => {
  const seeds = Array.from({ length: 24 }, (_, i) => 31_000 + i);
  it.each(seeds)('seed %i converts with every holding right', (seed) => {
    const truth = generatePortfolio(seed, dir);
    const e = evaluate(truth, dir);
    const wrong = [
      ...e.mapping.filter((m) => !m.ok).map((m) => `map "${m.header}" → ${m.got} (want ${m.expected})`),
      ...e.rows.filter((r) => !(r.found && r.holdingOk && r.mvLocalOk && r.mvPortOk && r.cicOk)).map((r) => `${r.truth.kind} "${r.truth.name}": ${r.detail}`),
    ];
    expect(wrong, `${truth.file} (${truth.language}/${truth.format})`).toEqual([]);
    expect(e.extraRows).toBe(0);
    expect(e.currencyOk && e.dateOk).toBe(true);
    expect(e.errors).toBe(0);
  });
});
