import { describe, expect, it } from 'vitest';
import { headerFingerprint, profileMapping, ProfileRepository } from './profiles.ts';
import { MemoryStore } from './store.ts';

describe('headerFingerprint', () => {
  it('ignores case, accents and punctuation but keeps order', () => {
    expect(headerFingerprint(['ISIN', 'Marknadsvärde (SEK)'])).toBe(headerFingerprint(['isin', 'marknadsvarde sek']));
    expect(headerFingerprint(['A', 'B'])).not.toBe(headerFingerprint(['B', 'A']));
    expect(headerFingerprint(['A'])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('ProfileRepository', () => {
  const headers = ['ISIN', 'Namn', 'Antal', 'Kommentar'];
  it('saves, finds (also with reordered headers), exports and imports', async () => {
    const repo = new ProfileRepository(new MemoryStore());
    const saved = await repo.save({ name: 'Custodian X', headers, mapping: ['isin', 'security_name', 'quantity', 'ignore'] });
    expect((await repo.findFor(['isin', 'namn', 'antal', 'kommentar']))?.name).toBe('Custodian X');
    expect((await repo.findFor(['Namn', 'ISIN', 'Kommentar', 'Antal']))?.fingerprint).toBe(saved.fingerprint);
    expect(await repo.findFor(['ISIN', 'Namn'])).toBeUndefined();
    expect([...profileMapping(saved, ['Antal', 'ISIN', 'Okänd'])]).toEqual([
      [0, 'quantity'],
      [1, 'isin'],
    ]);

    const exported = await repo.exportAll();
    const other = new ProfileRepository(new MemoryStore());
    expect(await other.importAll(JSON.parse(JSON.stringify(exported)))).toEqual({ imported: 1, skipped: 0 });
    expect((await other.list())[0].mapping.antal).toBe('quantity');
  });
  it('rejects invalid imports', async () => {
    const repo = new ProfileRepository(new MemoryStore());
    await expect(repo.importAll({ foo: 1 })).rejects.toThrow(/Not a TPT Generator/);
    const res = await repo.importAll({
      format: 'tpt-generator-source-profiles',
      version: 1,
      profiles: [{ fingerprint: 'bad', name: 'x', headers: ['a'], mapping: { a: 'isin' } }, { nonsense: true }],
    });
    expect(res).toEqual({ imported: 0, skipped: 2 });
  });
  it('counts usage and removes', async () => {
    const repo = new ProfileRepository(new MemoryStore());
    const p = await repo.save({ name: 'n', headers, mapping: ['isin', 'security_name', 'quantity', 'ignore'] });
    await repo.markUsed(p);
    expect((await repo.get(p.fingerprint))?.timesUsed).toBe(1);
    await repo.remove(p.fingerprint);
    expect(await repo.list()).toEqual([]);
  });
});
