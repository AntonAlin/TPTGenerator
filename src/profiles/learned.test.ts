import { describe, expect, it } from 'vitest';
import { applyProfile, bestProfile, headerKey, isGenericHeader, LearnedRepository } from './learned.ts';
import { ProfileRepository } from './profiles.ts';
import { MemoryStore } from './store.ts';
import { classifyColumns, learnedFloor, type LearnedHint } from '../detect/classify.ts';
import { lessonsFrom } from '../ui/session.ts';
import type { ColumnInput } from '../detect/features.ts';

describe('header keys and generic headers', () => {
  it('blanks dates and numbers so the same column on another date matches', () => {
    expect(headerKey('MV 30.09.2026')).toBe(headerKey('MV 31.10.2026'));
    expect(headerKey('Värde (SEK) 2026-09-30')).toBe('varde sek #');
    expect(headerKey('Price')).toBe('price');
  });
  it.each([['Col6', true], ['Unnamed: 3', true], ['#', true], ['', true], ['x', true], ['Kolumn 12', true], ['Bokfört värde', false], ['MV', false]])(
    '%s generic: %s',
    (h, want) => expect(isGenericHeader(h)).toBe(want),
  );
});

describe('profiles that fit a file whose columns changed a little', () => {
  const saved = {
    fingerprint: 'x',
    name: 'Custodian X',
    headers: ['isin', 'namn', 'antal', 'kurs', 'varde 2026 09 30', 'kommentar'],
    mapping: { isin: 'isin', namn: 'security_name', antal: 'quantity', kurs: 'price', 'varde 2026 09 30': 'market_value_local', kommentar: 'ignore' } as const,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    timesUsed: 3,
  };
  const profile = { ...saved, mapping: { ...saved.mapping } };

  it('maps a new date in a header, a new order and an added column', () => {
    const m = applyProfile(profile, ['Namn', 'ISIN', 'Antal', 'Kurs', 'Värde 2026-10-31', 'Kommentar', 'Ny kolumn']);
    expect(m.exact).toBe(false);
    expect(m.similarity).toBeCloseTo(6 / 7);
    expect([...m.mapping]).toEqual([[0, 'security_name'], [1, 'isin'], [2, 'quantity'], [3, 'price'], [4, 'market_value_local'], [5, 'ignore']]);
    expect(m.unknown).toEqual([6]);
    expect(bestProfile([profile], ['Namn', 'ISIN', 'Antal', 'Kurs', 'Värde 2026-10-31', 'Kommentar', 'Ny kolumn'])?.profile.name).toBe('Custodian X');
  });
  it('does not apply to another source', () => {
    expect(bestProfile([profile], ['ISIN', 'Name', 'Quantity', 'Price', 'Market value', 'Currency'])).toBeUndefined();
    expect(bestProfile([profile], ['ISIN', 'Namn'])).toBeUndefined();
  });
  it('uses a header key only when it is unambiguous', () => {
    const m = applyProfile(profile, ['ISIN', 'Namn', 'Antal', 'Kurs', 'Värde 2026-10-31', 'Värde 2026-09-01']);
    expect(m.mapping.has(4)).toBe(false);
    expect(m.mapping.has(5)).toBe(false);
  });
  it('the repository finds the changed layout', async () => {
    const repo = new ProfileRepository(new MemoryStore());
    await repo.save({ name: 'Custodian X', headers: ['ISIN', 'Namn', 'Antal', 'Kurs', 'Värde 2026-09-30', 'Kommentar'], mapping: ['isin', 'security_name', 'quantity', 'price', 'market_value_local', 'ignore'] });
    const m = await repo.matchFor(['ISIN', 'Namn', 'Antal', 'Kurs', 'Värde 2026-10-31']);
    expect(m?.profile.name).toBe('Custodian X');
    expect(m?.mapping.get(4)).toBe('market_value_local');
  });
});

describe('learning from corrections', () => {
  it('remembers, reinforces, lets the latest correction win and forgets', async () => {
    const repo = new LearnedRepository(new MemoryStore());
    await repo.learn([{ header: 'Bokfört värde', field: 'market_value_portfolio' }, { header: 'Col6', field: 'price' }], 'a.xlsx');
    expect((await repo.list()).map((l) => [l.header, l.field, l.times])).toEqual([['bokfort varde', 'market_value_portfolio', 1]]);
    await repo.learn([{ header: 'BOKFÖRT VÄRDE', field: 'market_value_portfolio' }], 'b.xlsx');
    expect((await repo.map()).get('bokfort varde')).toMatchObject({ times: 2, sources: ['b.xlsx', 'a.xlsx'] });
    await repo.learn([{ header: 'Bokfört värde', field: 'ignore' }], 'c.xlsx');
    expect((await repo.map()).get('bokfort varde')).toMatchObject({ field: 'ignore', times: 1, sources: ['c.xlsx'] });
    await repo.forget('Bokfört värde');
    expect(await repo.list()).toEqual([]);
  });
  it('imports only valid lessons', async () => {
    const repo = new LearnedRepository(new MemoryStore());
    const ok = { header: 'bokfort varde', field: 'market_value_portfolio', times: 2, sources: ['a.xlsx'], updatedAt: '2026-11-01T00:00:00Z' };
    const res = await repo.importAll([ok, { ...ok, header: 'Bokfört Värde' }, { ...ok, field: 'banana' }, { ...ok, header: 'col 3' }, null]);
    expect(res).toEqual({ imported: 1, skipped: 4 });
    expect(await repo.importAll(undefined)).toEqual({ imported: 0, skipped: 0 });
  });

  const cols = (extra: ColumnInput[]): ColumnInput[] => [
    { header: 'ISIN', values: ['SE0000108656', 'SE0000148884', 'US0378331005', 'SE0000667891'] },
    { header: 'Namn', values: ['Ericsson B', 'SEB A', 'Apple Inc', 'Sandvik'] },
    { header: 'Valuta', values: ['SEK', 'SEK', 'USD', 'SEK'] },
    { header: 'Antal', values: [1000, 2500, 300, 1200] },
    { header: 'Kurs', values: [62.5, 151.2, 228.1, 210.4] },
    { header: 'Marknadsvärde', values: [62500, 378000, 68430, 252480] },
    ...extra,
  ];
  const learned = (header: string, hint: LearnedHint) => new Map([[header, hint]]);

  it('a learned header maps the column, says why, and is taught again when kept', () => {
    const book = { header: 'Bokfört', values: [60100, 371000, 700100, 250300] };
    const before = classifyColumns(cols([book]))[6];
    expect(before.field).not.toBe('market_value_portfolio');
    const preds = classifyColumns(cols([book]), new Map(), { learned: learned('bokfort', { field: 'market_value_portfolio', times: 1, sources: ['oct.xlsx'] }) });
    const p = preds[6];
    expect(p.field).toBe('market_value_portfolio');
    expect(p.learned).toBe('market_value_portfolio');
    expect(p.confidence).toBeGreaterThanOrEqual(learnedFloor(1) - 1e-9);
    expect(p.reasons[0]).toMatch(/You mapped "Bokfört" to .* before, in oct\.xlsx/);
    expect(lessonsFrom(preds)).toEqual([{ header: 'Bokfört', field: 'market_value_portfolio' }]);
  });

  it('a lesson whose field the values cannot hold is not used', () => {
    const note = { header: 'Bokfört', values: ['ok', 'check', 'ok', 'sold'] };
    const p = classifyColumns(cols([note]), new Map(), { learned: learned('bokfort', { field: 'market_value_portfolio', times: 3, sources: ['oct.xlsx'] }) })[6];
    expect(p.field).not.toBe('market_value_portfolio');
    expect(p.learned).toBeUndefined();
    expect(p.reasons[0]).toMatch(/cannot be one, so that lesson was not used/);
  });

  it('matches a lesson on the same header with another date', () => {
    const book = { header: 'Bokfört 2026-10-31', values: [60100, 371000, 700100, 250300] };
    const p = classifyColumns(cols([book]), new Map(), { learned: learned('bokfort 2026 09 30', { field: 'market_value_portfolio', times: 2, sources: ['sep.xlsx'] }) })[6];
    expect(p.field).toBe('market_value_portfolio');
  });

  it('pinned columns teach; profile columns and untouched model columns do not', () => {
    const preds = classifyColumns(cols([]), new Map([[5, { field: 'market_value_portfolio' as const, source: 'user' as const }], [0, { field: 'isin' as const, source: 'profile' as const }]]));
    expect(lessonsFrom(preds)).toEqual([{ header: 'Marknadsvärde', field: 'market_value_portfolio' }]);
  });
});
