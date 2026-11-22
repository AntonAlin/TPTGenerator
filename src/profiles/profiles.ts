/**
 * Source profiles: remembered column mappings for files from the same source,
 * keyed by a fingerprint of the (normalised) headers. Stored in IndexedDB in
 * the user's browser; exportable/importable as JSON.
 */
import type { CanonicalField } from '../detect/canonical.ts';
import { CANONICAL_FIELDS } from '../detect/canonical.ts';
import { normalizeHeader } from '../detect/headerMatch.ts';
import type { KeyValueStore } from './store.ts';
import { applyProfile, bestProfile, type LearnedHeader, type LearnedType, type ProfileMatch } from './learned.ts';

export interface SourceProfile {
  fingerprint: string;
  name: string;
  /** Normalised headers in file order. */
  headers: string[];
  /** Mapping by normalised header. */
  mapping: Record<string, CanonicalField>;
  /** Optional parsing hints remembered for this source. */
  options?: { headerRowOffset?: number; decimal?: ',' | '.'; dateOrder?: 'DMY' | 'MDY'; sheetName?: string };
  createdAt: string;
  updatedAt: string;
  timesUsed: number;
}

export interface ProfileExport {
  format: 'tpt-generator-source-profiles';
  version: 1;
  exportedAt: string;
  profiles: SourceProfile[];
  /** Headers learned from the user's corrections (optional; older exports have none). */
  learned?: LearnedHeader[];
  /** Asset-type texts the user gave a class (optional). */
  learnedTypes?: LearnedType[];
}

/** FNV-1a 64-bit over the normalised, order-preserving header list → hex. Deterministic, sync, no crypto needed. */
export function headerFingerprint(headers: string[]): string {
  const text = headers.map(normalizeHeader).join('\u001f');
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const ch of new TextEncoder().encode(text)) {
    h ^= BigInt(ch);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

const STORE_PREFIX = 'profile:';

export class ProfileRepository {
  constructor(private store: KeyValueStore) {}

  async list(): Promise<SourceProfile[]> {
    const all = await this.store.entries<SourceProfile>(STORE_PREFIX);
    return all.map(([, v]) => v).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(fingerprint: string): Promise<SourceProfile | undefined> {
    return this.store.get<SourceProfile>(STORE_PREFIX + fingerprint);
  }

  /** Find a profile for these headers: exact fingerprint first, then the closest one if it is close enough. */
  async findFor(headers: string[]): Promise<SourceProfile | undefined> {
    return (await this.matchFor(headers))?.profile;
  }

  /**
   * The profile that fits these headers, and how: the same columns in the same order, the same
   * columns in another order, or a file from the same source whose columns changed a little (a date
   * in a header, a column added or dropped). Columns the profile does not know are classified as usual.
   */
  async matchFor(headers: string[]): Promise<ProfileMatch | undefined> {
    const exact = await this.get(headerFingerprint(headers));
    if (exact) return applyProfile(exact, headers);
    return bestProfile(await this.list(), headers);
  }

  async save(input: { name: string; headers: string[]; mapping: CanonicalField[]; options?: SourceProfile['options'] }): Promise<SourceProfile> {
    const fingerprint = headerFingerprint(input.headers);
    const existing = await this.get(fingerprint);
    const now = new Date().toISOString();
    const normalized = input.headers.map(normalizeHeader);
    const profile: SourceProfile = {
      fingerprint,
      name: input.name,
      headers: normalized,
      mapping: Object.fromEntries(normalized.map((h, i) => [h, input.mapping[i]])),
      options: input.options,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      timesUsed: existing?.timesUsed ?? 0,
    };
    await this.store.set(STORE_PREFIX + fingerprint, profile);
    return profile;
  }

  async markUsed(p: SourceProfile): Promise<void> {
    await this.store.set(STORE_PREFIX + p.fingerprint, { ...p, timesUsed: p.timesUsed + 1 });
  }

  async remove(fingerprint: string): Promise<void> {
    await this.store.delete(STORE_PREFIX + fingerprint);
  }

  async exportAll(): Promise<ProfileExport> {
    return { format: 'tpt-generator-source-profiles', version: 1, exportedAt: new Date().toISOString(), profiles: await this.list() };
  }

  /** Import profiles; returns counts. Invalid entries are rejected, never partially stored. */
  async importAll(data: unknown, overwrite = true): Promise<{ imported: number; skipped: number }> {
    const d = data as Partial<ProfileExport>;
    if (d?.format !== 'tpt-generator-source-profiles' || !Array.isArray(d.profiles)) {
      throw new Error('Not a TPT Generator source profile export.');
    }
    let imported = 0;
    let skipped = 0;
    for (const p of d.profiles) {
      if (!isValidProfile(p)) {
        skipped++;
        continue;
      }
      if (!overwrite && (await this.get(p.fingerprint))) {
        skipped++;
        continue;
      }
      await this.store.set(STORE_PREFIX + p.fingerprint, p);
      imported++;
    }
    return { imported, skipped };
  }
}

function isValidProfile(p: unknown): p is SourceProfile {
  const x = p as SourceProfile;
  return (
    !!x &&
    typeof x.fingerprint === 'string' &&
    typeof x.name === 'string' &&
    Array.isArray(x.headers) &&
    x.headers.every((h) => typeof h === 'string') &&
    typeof x.mapping === 'object' &&
    Object.values(x.mapping).every((f) => (CANONICAL_FIELDS as readonly string[]).includes(f as string)) &&
    headerFingerprint(x.headers) === x.fingerprint
  );
}

/**
 * Apply a profile to the current headers: returns column index → field for headers the profile
 * knows, by exact header or, when unambiguous, by the same header with other dates or numbers in it.
 */
export function profileMapping(profile: SourceProfile, headers: string[]): Map<number, CanonicalField> {
  return applyProfile(profile, headers).mapping;
}
