import { describe, expect, it } from 'vitest';
import { ATTRS, attrOptions, isNaceFormat } from './attributes.ts';
import { instrumentKey, issuerKey, SecurityMaster } from './securityMaster.ts';
import { MemoryStore } from '../profiles/store.ts';
import { maybeField } from '../spec/index.ts';

describe('attributes', () => {
  it('every TPT field referenced exists in the active spec', () => {
    for (const a of ATTRS) for (const id of a.tpt) expect(maybeField(id), `${a.key} → ${id}`).toBeDefined();
  });
  it('code options come from the spec', () => {
    expect(attrOptions('interest_rate_type')?.map((o) => o.code)).toEqual(['Fixed', 'Floating', 'Variable', 'Inflation_linked']);
    expect(attrOptions('issuer_id_type')?.map((o) => o.code)).toEqual(['1', '2', '9']);
    expect(attrOptions('cqs')?.map((o) => o.code)).toContain('9');
  });
  it('NACE format', () => {
    expect(isNaceFormat('K6419')).toBe(true);
    expect(isNaceFormat('C')).toBe(true);
    expect(isNaceFormat('K64.19')).toBe(false);
    expect(isNaceFormat('64')).toBe(false);
  });
});

describe('keys', () => {
  it('prefers ISIN, then other id, then normalised name', () => {
    expect(instrumentKey({ isin: 'se0000108656', name: 'x' })).toBe('isin:SE0000108656');
    expect(instrumentKey({ otherId: 'eric b', name: 'x' })).toBe('id:ERIC B');
    expect(instrumentKey({ name: 'Likvida medel, SEK' })).toBe('name:LIKVIDA MEDEL SEK');
    expect(issuerKey({ lei: 'abc', name: 'x' })).toBe('lei:ABC');
    expect(issuerKey({ name: 'Telefonaktiebolaget LM Ericsson' })).toBe('name:TELEFONAKTIEBOLAGET LM ERICSSON');
    expect(instrumentKey({})).toBeUndefined();
  });
});

describe('SecurityMaster', () => {
  it('stores instrument and issuer values, persists, exports and imports', async () => {
    const store = new MemoryStore();
    const m = await SecurityMaster.open(store);
    await m.set('cic', 'isin:SE0000108656', 'Ericsson B', 'SE31');
    await m.set('nace', 'name:ERICSSON', 'Ericsson', 'C2630');
    await m.set('credit_rating', 'isin:SE0000108656', 'Ericsson B', 'BBB', true);
    expect(m.get('instrument', 'isin:SE0000108656')?.attrs.cic?.value).toBe('SE31');
    expect(m.get('instrument', 'isin:SE0000108656')?.attrs.credit_rating?.override).toBe(true);
    expect(m.get('issuer', 'name:ERICSSON')?.attrs.nace?.value).toBe('C2630');
    await expect(m.set('weight', 'k', 'l', 1)).rejects.toThrow(/not maintained/);

    // Reopen from the same store.
    const again = await SecurityMaster.open(store);
    expect(again.size).toBe(2);

    // Clear one attribute.
    await again.set('cic', 'isin:SE0000108656', 'Ericsson B', undefined);
    expect(again.get('instrument', 'isin:SE0000108656')?.attrs.cic).toBeUndefined();

    const exported = JSON.parse(JSON.stringify(m.export()));
    const other = await SecurityMaster.open(new MemoryStore());
    expect(await other.import(exported)).toEqual({ records: 2, skipped: 0 });
    expect(other.get('issuer', 'name:ERICSSON')?.attrs.nace?.value).toBe('C2630');
  });
  it('import keeps the newer value and rejects junk', async () => {
    const m = await SecurityMaster.open(new MemoryStore());
    await m.set('cic', 'isin:X', 'X', 'SE31');
    await m.import({
      format: 'tpt-generator-security-master',
      version: 1,
      records: [
        { key: 'isin:X', level: 'instrument', label: 'X', updatedAt: '2000-01-01', attrs: { cic: { value: 'SE32', updatedAt: '2000-01-01' } } },
        { key: 'isin:Y', level: 'instrument', label: 'Y', updatedAt: '2000-01-01', attrs: { weight: { value: 1, updatedAt: '2000' }, nace: { value: 'C', updatedAt: '2000' } } },
        { nonsense: true },
      ],
    });
    expect(m.get('instrument', 'isin:X')?.attrs.cic?.value).toBe('SE31');
    expect(m.get('instrument', 'isin:Y')?.attrs).toEqual({});
    await expect(m.import({ foo: 1 })).rejects.toThrow(/Not a TPT Generator/);
  });
});
