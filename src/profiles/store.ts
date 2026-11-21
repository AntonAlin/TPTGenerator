/**
 * Minimal async key-value store with an IndexedDB implementation (browser) and
 * an in-memory implementation (tests, or when IndexedDB is unavailable, e.g.
 * some private browsing modes). Data never leaves the user's browser.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  entries<T>(prefix: string): Promise<[string, T][]>;
  readonly persistent: boolean;
}

export class MemoryStore implements KeyValueStore {
  readonly persistent = false;
  private map = new Map<string, unknown>();
  async get<T>(key: string) {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set<T>(key: string, value: T) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async entries<T>(prefix: string) {
    return [...this.map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T] as [string, T]);
  }
}

const DB_NAME = 'tpt-generator';
const STORE = 'kv';

export class IndexedDbStore implements KeyValueStore {
  readonly persistent = true;
  private db: Promise<IDBDatabase>;
  constructor(dbName = DB_NAME) {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async get<T>(key: string) {
    return (await this.tx('readonly', (s) => s.get(key))) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    await this.tx('readwrite', (s) => s.put(value, key));
  }
  async delete(key: string) {
    await this.tx('readwrite', (s) => s.delete(key));
  }
  async entries<T>(prefix: string) {
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const [keys, values] = await Promise.all([
      this.tx('readonly', (s) => s.getAllKeys(range)),
      this.tx('readonly', (s) => s.getAll(range)),
    ]);
    return keys.map((k, i) => [String(k), values[i] as T] as [string, T]);
  }
}

/** IndexedDB when available, otherwise memory (with `persistent` = false so the UI can warn). */
export async function openStore(): Promise<KeyValueStore> {
  try {
    if (typeof indexedDB === 'undefined') return new MemoryStore();
    const s = new IndexedDbStore();
    await s.entries('__probe__');
    return s;
  } catch {
    return new MemoryStore();
  }
}
