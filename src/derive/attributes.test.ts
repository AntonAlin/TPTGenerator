import { describe, expect, it } from 'vitest';
import { ATTRS, isNaceFormat } from './attributes.ts';
import { maybeField, field } from '../spec/index.ts';
import { naceItems, naceLookup } from '../data/nace.ts';
import { validateFieldValue } from '../spec/validate.ts';

describe('attributes', () => {
  it('every TPT field referenced exists in the active spec', () => {
    for (const a of ATTRS) for (const id of a.tpt) expect(maybeField(id), `${a.key} → ${id}`).toBeDefined();
  });
  it('NACE format', () => {
    expect(isNaceFormat('K6419')).toBe(true);
    expect(isNaceFormat('C')).toBe(true);
    expect(isNaceFormat('K64.19')).toBe(false);
    expect(isNaceFormat('64')).toBe(false);
  });
});

describe('NACE list', () => {
  it('has the full NACE Rev. 2 structure in TPT format', () => {
    const count = (l: string) => naceItems.filter((i) => i.level === l).length;
    expect([count('section'), count('division'), count('group'), count('class')]).toEqual([21, 88, 272, 615]);
    expect(naceLookup('k6419')?.label).toBe('Other monetary intermediation');
    expect(naceLookup('U9900')?.supplement).toMatch(/Not in the supplied PDF/);
    expect(naceItems.every((i) => /^[A-U](\d{2}|\d{3}|\d{4})?$/.test(i.code))).toBe(true);
  });
  it('field 148 validation checks the list', () => {
    expect(validateFieldValue(field('148'), 'K6419')).toBeUndefined();
    expect(validateFieldValue(field('148'), 'K6488')).toMatch(/not a code/);
  });
});
