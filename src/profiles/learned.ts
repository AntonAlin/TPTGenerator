/**
 * What the app learns from the user's own corrections, kept in this browser only:
 *
 * - Learned headers: when the user maps a column by hand, its header → field is remembered and
 *   counts as strong evidence the next time any file has that header. Strong, not absolute: the
 *   values must still be compatible with the field, so "Värde" learned as a market value in one
 *   file cannot turn a text column into one in another.
 * - Header keys and profile similarity: a saved source profile also fits a file whose columns
 *   changed a little (a date in a header, a column added or dropped, a new order).
 *
 * Nothing here leaves the browser; it is exported and imported only by the user, as a file.
 */
import { CANONICAL_FIELDS, type CanonicalField } from '../detect/canonical.ts';
import { ASSET_CLASSES, type AssetClass } from '../derive/assetClass.ts';
import { headerKey, normalizeHeader } from '../detect/headerMatch.ts';
import type { SourceProfile } from './profiles.ts';
import type { KeyValueStore } from './store.ts';

export { headerKey };

/** Headers that say nothing about the column ("Col6", "Unnamed: 3", "#") are never learned. */
export function isGenericHeader(h: string): boolean {
  const n = normalizeHeader(h);
  return /^(col|column|kolumn|spalte|colonne|field|felt|falt|unnamed|untitled|header|f|c)? ?\d*$/.test(n) || n.replace(/[ \d]/g, '').length < 2;
}

export interface ProfileMatch {
  profile: SourceProfile;
  /** Share of the union of both header sets that the two have in common (1 = same columns). */
  similarity: number;
  /** Column index → field, for the columns the profile knows. */
  mapping: Map<number, CanonicalField>;
  /** Columns of the file the profile does not know (classified as usual). */
  unknown: number[];
  /** Whether the headers are exactly the profile's (in any order). */
  exact: boolean;
}

/** Minimum similarity, and minimum columns in common, for a profile to apply to a changed file. */
export const MIN_PROFILE_SIMILARITY = 0.6;
const MIN_SHARED = 3;

/** How a profile's mapping applies to these headers: exact header first, else the same key when it is unique on both sides. */
export function applyProfile(profile: SourceProfile, headers: string[]): ProfileMatch {
  const norm = headers.map(normalizeHeader);
  const keyCount = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const fileKeys = headers.map(headerKey);
  const profKeys = profile.headers.map(headerKey);
  const fileKeyN = keyCount(fileKeys);
  const profKeyN = keyCount(profKeys);
  const byKey = new Map<string, CanonicalField>();
  profile.headers.forEach((h, i) => {
    if (profKeyN.get(profKeys[i]) === 1 && profile.mapping[h]) byKey.set(profKeys[i], profile.mapping[h]);
  });
  const mapping = new Map<number, CanonicalField>();
  const unknown: number[] = [];
  norm.forEach((h, i) => {
    const f = profile.mapping[h] ?? (fileKeyN.get(fileKeys[i]) === 1 ? byKey.get(fileKeys[i]) : undefined);
    if (f) mapping.set(i, f);
    else unknown.push(i);
  });
  const fileSet = new Set(fileKeys);
  const profSet = new Set(profKeys);
  const shared = [...fileSet].filter((k) => profSet.has(k)).length;
  const union = new Set([...fileSet, ...profSet]).size;
  const exactSet = new Set(norm);
  const exact = profile.headers.length === exactSet.size && profile.headers.every((h) => exactSet.has(h));
  return { profile, similarity: exact ? 1 : union ? shared / union : 0, mapping, unknown, exact };
}

/** The saved profile that fits these headers best, if any fits well enough. */
export function bestProfile(profiles: SourceProfile[], headers: string[]): ProfileMatch | undefined {
  let best: ProfileMatch | undefined;
  for (const p of profiles) {
    const m = applyProfile(p, headers);
    if (!m.exact && (m.similarity < MIN_PROFILE_SIMILARITY || m.mapping.size < MIN_SHARED)) continue;
    if (!best || m.similarity > best.similarity || (m.similarity === best.similarity && p.updatedAt > best.profile.updatedAt)) best = m;
  }
  return best;
}

export interface LearnedHeader {
  /** Normalised header. */
  header: string;
  field: CanonicalField;
  /** How many confirmed mappings taught it (a correction to another field starts again at 1). */
  times: number;
  /** File names it was learned from, most recent first (at most 5). */
  sources: string[];
  updatedAt: string;
}

/** Learned headers by normalised header, as the classifier takes them. */
export type LearnedHeaders = Map<string, LearnedHeader>;

const PREFIX = 'learned-header:';
const TYPE_PREFIX = 'learned-type:';

/** An asset-type text (a file's own code, like "OPT", "21" or "Aktie, onoterad") the user gave a class. */
export interface LearnedType {
  /** Normalised type text (resolve.ts typeTextKey). */
  text: string;
  /** The text as the file wrote it, for display. */
  shown: string;
  cls: AssetClass;
  sources: string[];
  updatedAt: string;
}

export class LearnedRepository {
  constructor(private store: KeyValueStore) {}

  async list(): Promise<LearnedHeader[]> {
    return (await this.store.entries<LearnedHeader>(PREFIX)).map(([, v]) => v).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async map(): Promise<LearnedHeaders> {
    return new Map((await this.list()).map((l) => [l.header, l]));
  }

  /**
   * Learn from a confirmed mapping: the columns the user set by hand. Returns what was learned or
   * changed. A header taught to a new field replaces the old lesson: the latest correction wins.
   */
  async learn(corrections: { header: string; field: CanonicalField }[], source: string): Promise<LearnedHeader[]> {
    const out: LearnedHeader[] = [];
    const now = new Date().toISOString();
    for (const c of corrections) {
      if (isGenericHeader(c.header)) continue;
      const header = normalizeHeader(c.header);
      const old = await this.store.get<LearnedHeader>(PREFIX + header);
      const same = old?.field === c.field;
      const entry: LearnedHeader = {
        header,
        field: c.field,
        times: same ? old.times + 1 : 1,
        sources: [source, ...(same ? old.sources.filter((s) => s !== source) : [])].slice(0, 5),
        updatedAt: now,
      };
      await this.store.set(PREFIX + header, entry);
      out.push(entry);
    }
    return out;
  }

  async forget(header: string): Promise<void> {
    await this.store.delete(PREFIX + normalizeHeader(header));
  }

  async types(): Promise<LearnedType[]> {
    return (await this.store.entries<LearnedType>(TYPE_PREFIX)).map(([, v]) => v).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Type lessons as resolve.ts takes them. */
  async typeMap(): Promise<Map<string, { cls: AssetClass; source?: string }>> {
    return new Map((await this.types()).map((t) => [t.text, { cls: t.cls, source: t.sources[0] }]));
  }

  /** Remember the class of an asset-type text; the latest choice wins. */
  async teachType(shown: string, cls: AssetClass, source: string): Promise<LearnedType> {
    const text = normalizeHeader(shown);
    const old = await this.store.get<LearnedType>(TYPE_PREFIX + text);
    const entry: LearnedType = {
      text,
      shown: shown.trim(),
      cls,
      sources: [source, ...(old?.cls === cls ? old.sources.filter((s) => s !== source) : [])].slice(0, 5),
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(TYPE_PREFIX + text, entry);
    return entry;
  }

  async forgetType(shown: string): Promise<void> {
    await this.store.delete(TYPE_PREFIX + normalizeHeader(shown));
  }

  async importTypes(items: unknown): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const t of Array.isArray(items) ? items : []) {
      const x = t as LearnedType;
      const ok =
        !!x && typeof x.text === 'string' && !!x.text && x.text === normalizeHeader(x.text) && typeof x.shown === 'string' && x.cls in ASSET_CLASSES &&
        Array.isArray(x.sources) && x.sources.every((s) => typeof s === 'string') && typeof x.updatedAt === 'string';
      if (!ok) {
        skipped++;
        continue;
      }
      await this.store.set(TYPE_PREFIX + x.text, x);
      imported++;
    }
    return { imported, skipped };
  }

  /** Store imported lessons (from a profile export); invalid entries are skipped. */
  async importAll(items: unknown): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const l of Array.isArray(items) ? items : []) {
      if (!isValidLearned(l)) {
        skipped++;
        continue;
      }
      await this.store.set(PREFIX + l.header, l);
      imported++;
    }
    return { imported, skipped };
  }
}

function isValidLearned(x: unknown): x is LearnedHeader {
  const l = x as LearnedHeader;
  return (
    !!l &&
    typeof l.header === 'string' &&
    l.header === normalizeHeader(l.header) &&
    !isGenericHeader(l.header) &&
    (CANONICAL_FIELDS as readonly string[]).includes(l.field) &&
    Number.isInteger(l.times) &&
    l.times >= 1 &&
    Array.isArray(l.sources) &&
    l.sources.every((s) => typeof s === 'string') &&
    typeof l.updatedAt === 'string'
  );
}
