/**
 * The user's own reference database ("security master"), stored in the
 * browser (IndexedDB). It grows as the user fills in or corrects data and is
 * exportable/importable as JSON. Values here take priority over derived
 * values; values marked `override` also take priority over the input file.
 *
 * Instrument records are keyed by ISIN (or another identifier / normalised
 * name when there is no ISIN). Issuer records are keyed by issuer LEI or
 * normalised issuer name, so one entry applies to every holding of that issuer.
 */
import type { KeyValueStore } from '../profiles/store.ts';
import { ATTR, type AttrKey, type MasterLevel } from './attributes.ts';
import type { Scalar } from '../derive/provenance.ts';

export interface MasterValue {
  value: Scalar;
  updatedAt: string;
  /** If true, this value wins over the input file as well. */
  override?: boolean;
}

export interface MasterRecord {
  key: string;
  level: MasterLevel;
  /** Human-readable label (name of instrument or issuer). */
  label: string;
  attrs: Partial<Record<AttrKey, MasterValue>>;
  updatedAt: string;
}

export interface MasterExport {
  format: 'tpt-generator-security-master';
  version: 1;
  exportedAt: string;
  records: MasterRecord[];
}

const normName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

export function instrumentKey(h: { isin?: string; otherId?: string; name?: string }): string | undefined {
  if (h.isin) return `isin:${h.isin.trim().toUpperCase()}`;
  if (h.otherId) return `id:${h.otherId.trim().toUpperCase()}`;
  if (h.name) return `name:${normName(h.name)}`;
  return undefined;
}

export function issuerKey(i: { lei?: string; name?: string }): string | undefined {
  if (i.lei) return `lei:${i.lei.trim().toUpperCase()}`;
  if (i.name) return `name:${normName(i.name)}`;
  return undefined;
}

const PREFIX: Record<MasterLevel, string> = { instrument: 'master:i:', issuer: 'master:e:' };

export class SecurityMaster {
  /** In-memory cache so resolution can run synchronously. */
  private cache = new Map<string, MasterRecord>();

  private constructor(private store: KeyValueStore) {}

  static async open(store: KeyValueStore): Promise<SecurityMaster> {
    const m = new SecurityMaster(store);
    for (const level of ['instrument', 'issuer'] as MasterLevel[]) {
      for (const [, rec] of await store.entries<MasterRecord>(PREFIX[level])) m.cache.set(PREFIX[level] + rec.key, rec);
    }
    return m;
  }

  get size() {
    return this.cache.size;
  }

  get(level: MasterLevel, key: string | undefined): MasterRecord | undefined {
    return key ? this.cache.get(PREFIX[level] + key) : undefined;
  }

  all(): MasterRecord[] {
    return [...this.cache.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Set (or clear, with value undefined) one attribute. The attribute decides the level. */
  async set(attr: AttrKey, key: string, label: string, value: Scalar | undefined, override = false): Promise<MasterRecord> {
    const level = ATTR[attr].master;
    if (!level) throw new Error(`${attr} is not maintained in the security master.`);
    const now = new Date().toISOString();
    const existing = this.get(level, key);
    const rec: MasterRecord = existing ? structuredClone(existing) : { key, level, label, attrs: {}, updatedAt: now };
    rec.label = label || rec.label;
    if (value === undefined || value === '') delete rec.attrs[attr];
    else rec.attrs[attr] = { value, updatedAt: now, ...(override ? { override: true } : {}) };
    rec.updatedAt = now;
    this.cache.set(PREFIX[level] + key, rec);
    await this.store.set(PREFIX[level] + key, rec);
    return rec;
  }

  async remove(level: MasterLevel, key: string) {
    this.cache.delete(PREFIX[level] + key);
    await this.store.delete(PREFIX[level] + key);
  }

  export(): MasterExport {
    return { format: 'tpt-generator-security-master', version: 1, exportedAt: new Date().toISOString(), records: this.all() };
  }

  /** Merge an export: newer attribute values win. Returns counts. */
  async import(data: unknown): Promise<{ records: number; skipped: number }> {
    const d = data as Partial<MasterExport>;
    if (d?.format !== 'tpt-generator-security-master' || !Array.isArray(d.records)) throw new Error('Not a TPT Generator security master export.');
    let records = 0;
    let skipped = 0;
    for (const r of d.records) {
      if (!r || typeof r.key !== 'string' || (r.level !== 'instrument' && r.level !== 'issuer') || typeof r.attrs !== 'object') {
        skipped++;
        continue;
      }
      const existing = this.get(r.level, r.key);
      const merged: MasterRecord = existing ? structuredClone(existing) : { key: r.key, level: r.level, label: String(r.label ?? r.key), attrs: {}, updatedAt: r.updatedAt };
      for (const [k, v] of Object.entries(r.attrs) as [AttrKey, MasterValue][]) {
        if (!ATTR[k] || ATTR[k].master !== r.level || !v || (typeof v.value !== 'string' && typeof v.value !== 'number')) continue;
        const cur = merged.attrs[k];
        if (!cur || cur.updatedAt <= v.updatedAt) merged.attrs[k] = v;
      }
      merged.updatedAt = [merged.updatedAt, r.updatedAt].sort().pop()!;
      this.cache.set(PREFIX[r.level] + r.key, merged);
      await this.store.set(PREFIX[r.level] + r.key, merged);
      records++;
    }
    return { records, skipped };
  }
}
