import { describe, expect, it } from 'vitest';
import { CLASS_FIELDS, emptyPortfolio, FUND_FIELDS, FundProfileRepository, fundNav, PORTFOLIO_FIELDS, resolvePortfolioField } from './portfolio.ts';
import { MemoryStore } from '../profiles/store.ts';
import { validateFieldValue } from '../spec/validate.ts';
import { field } from '../spec/index.ts';
import { derived } from '../derive/provenance.ts';

describe('portfolio fields from the spec', () => {
  it('contains the portfolio sections, excludes must-be-empty and automatic fields', () => {
    const ids = PORTFOLIO_FIELDS.map((f) => f.id);
    for (const id of ['1', '2', '3', '4', '5', '6', '7', '8', '8b', '9', '10', '11', '115', '117', '119', '121', '122', '123', '123a', '133', '140']) expect(ids).toContain(id);
    for (const id of ['116', '118', '120', '124', '125', '126', '1000', '12']) expect(ids).not.toContain(id);
    expect(CLASS_FIELDS.map((f) => f.id)).toEqual(['1', '2', '3', '4', '5', '8', '8b']);
    expect(FUND_FIELDS.map((f) => f.id)).not.toContain('5');
  });
});

describe('validateFieldValue', () => {
  it.each([
    ['6', '2026-09-30', true],
    ['6', '30/09/2026', false],
    ['4', 'SEK', true],
    ['4', 'CNH', true],
    ['4', 'XXQ', false],
    ['52', 'XA', true],
    ['122', 'XA', false],
    ['12', 'SE31', true],
    ['12', 'SE35', false],
    ['2', '1', true],
    ['2', '42', false],
    ['5', '1234.5', true],
    ['5', '1 234,5', false],
    ['148', 'K6419', true],
    ['148', 'K64.19', false],
    ['3', 'x'.repeat(256), false],
  ])('%s = %s → %s', (id, v, ok) => expect(validateFieldValue(field(id), v) === undefined).toBe(ok));
});

describe('portfolio derivations', () => {
  it('fills id type, reporting date, SCR flag, cash ratio and duration when not entered', () => {
    const d = { nav: derived(1, 'x', 'high'), cashRatio: derived(0.05, 'c', 'medium'), modifiedDuration: derived(3.2, 'd', 'low') };
    expect(resolvePortfolioField('2', { '1': 'SE0000108656' }, d).value).toBe('1');
    expect(resolvePortfolioField('2', { '1': 'ABC' }, d).source).toBe('missing');
    expect(resolvePortfolioField('7', {}, d, '2026-10-01').value).toBe('2026-10-01');
    expect(resolvePortfolioField('11', {}, d).value).toBe('N');
    expect(resolvePortfolioField('9', {}, d).value).toBe(0.05);
    expect(resolvePortfolioField('10', { '10': '4.1' }, d)).toMatchObject({ value: '4.1', source: 'user' });
  });
  it('computes fund NAV at fund and share class level', () => {
    const p = emptyPortfolio();
    p.values['5'] = '1000000';
    expect(fundNav(p, () => 1).nav).toBe(1000000);
    p.level = 'share_class';
    p.baseCurrency = 'SEK';
    p.shareClasses = [{ values: { '4': 'SEK', '5': '500' } }, { values: { '4': 'EUR', '5': '100' } }];
    expect(fundNav(p, (c) => (c === 'EUR' ? 11 : c === 'SEK' ? 1 : undefined)).nav).toBe(1600);
    expect(fundNav(p, (c) => (c === 'SEK' ? 1 : undefined)).note).toMatch(/EUR/);
  });
});

describe('FundProfileRepository', () => {
  it('saves identification without period values, exports and imports', async () => {
    const repo = new FundProfileRepository(new MemoryStore());
    const p = emptyPortfolio();
    p.values = { '1': 'SE0000000001', '3': 'Exempelfonden', '4': 'SEK', '5': '123', '6': '2026-09-30' };
    p.conventions.valuationDate = '2026-09-30';
    p.fxUser = { EUR: 11 };
    const saved = await repo.save('Exempelfonden', p);
    expect(saved.state.values).toEqual({ '1': 'SE0000000001', '3': 'Exempelfonden', '4': 'SEK' });
    expect(saved.state.conventions.valuationDate).toBeUndefined();
    expect(saved.state.fxUser).toEqual({});
    const other = new FundProfileRepository(new MemoryStore());
    expect(await other.importAll(JSON.parse(JSON.stringify(await repo.exportAll())))).toBe(1);
    expect((await other.list())[0].name).toBe('Exempelfonden');
    await expect(other.importAll({})).rejects.toThrow();
  });
});
