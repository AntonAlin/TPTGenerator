import { describe, expect, it } from 'vitest';
import { buildCic, cicTable, parseCic } from './cic.ts';
import { field } from '../spec/index.ts';

describe('parseCic', () => {
  it('accepts valid codes', () => {
    const r = parseCic('SE11');
    expect(r.valid).toBe(true);
    expect(r.locationKind).toBe('country');
    expect(r.category?.name).toBe('Government bonds');
    expect(r.subcategory?.name).toBe('Central Government bonds');
    expect(parseCic('xl46').valid).toBe(true);
    expect(parseCic('XT72').locationKind).toBe('XT');
    expect(parseCic('DEF1').subcategory?.name).toBe('Credit default swap');
  });
  it('rejects sub-categories that do not exist for the category', () => {
    expect(parseCic('SE17').valid).toBe(false); // no 7 under government bonds
    expect(parseCic('XL83').valid).toBe(false); // no 3 under mortgages and loans
    expect(parseCic('XLE3').valid).toBe(false);
  });
  it('rejects malformed codes and unknown categories', () => {
    expect(parseCic('SE1').valid).toBe(false);
    expect(parseCic('S111').valid).toBe(false);
    expect(parseCic('SE01').errors[0]).toMatch(/Category "0"/);
  });
  it('uses the injected country check', () => {
    expect(parseCic('QQ11', (c) => c === 'SE').valid).toBe(false);
    expect(parseCic('SE11', (c) => c === 'SE').valid).toBe(true);
    expect(parseCic('XL11', () => false).valid).toBe(true);
  });
  it('buildCic only returns codes in the table', () => {
    expect(buildCic('se', '2', '1')).toBe('SE21');
    expect(buildCic('SE', '3', '5')).toBeUndefined();
  });
});

describe('CIC table consistency with the TPT spec', () => {
  it('every category is a code in TPT field 131 (underlying asset category)', () => {
    const codes = new Set(field('131').codeList?.map((c) => c.code));
    for (const cat of cicTable.categories) {
      // Equity is split into 3L/3X in field 131.
      expect(codes.has(cat.code) || codes.has(`${cat.code}L`)).toBe(true);
    }
  });
  it('every category has a TPT CIC applicability column', () => {
    const cols = Object.keys(field('12').cicApplicability);
    for (const cat of cicTable.categories) expect(cols).toContain(cat.code);
  });
  it('every category has an "Other" (9) sub-category', () => {
    for (const cat of cicTable.categories) expect(cat.subcategories.find((s) => s.code === '9')?.name).toBe('Other');
  });
});
