/**
 * Header normalisation and fuzzy matching against the synonym dictionary.
 */
import synonymsJson from './synonyms.json';
import { CANONICAL_FIELDS, type CanonicalField } from './canonical.ts';

export type SynonymDictionary = Partial<Record<CanonicalField, Record<string, string[]>>>;

/** Lowercase, strip accents (å→a, ü→u, é→e, ß→ss), turn punctuation into spaces, collapse whitespace. */
export function normalizeHeader(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/%/g, ' % ')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const ratio = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/**
 * Similarity in [0,1] between a normalised header and a normalised synonym.
 * Combines exact match, token containment, compact (space-free) match and edit distance.
 */
export function headerSimilarity(header: string, synonym: string): number {
  if (!header || !synonym) return 0;
  if (header === synonym) return 1;
  const ht = header.split(' ');
  const st = synonym.split(' ');
  let best = 0;
  if (header.replace(/ /g, '') === synonym.replace(/ /g, '')) best = 0.97;
  // All synonym tokens present in the header ("market value" ⊂ "market value sek").
  if (st.every((t) => ht.includes(t))) best = Math.max(best, 0.8 + 0.18 * (st.length / ht.length));
  // A one-word header inside a longer synonym ("mv" vs "mv local") – weaker. Not for multi-word
  // headers: "market value" is not "nominal / market value".
  else if (ht.length === 1 && st.includes(ht[0])) best = Math.max(best, 0.6 + 0.3 * (ht.length / st.length));
  // Whole-string edit distance (typos, small variations); ignore for very short strings.
  if (Math.min(header.length, synonym.length) >= 4) best = Math.max(best, ratio(header, synonym) * 0.95);
  // Token-wise fuzzy coverage of the synonym ("maturty date" ~ "maturity date").
  if (st.length > 1 || synonym.length >= 5) {
    let sum = 0;
    for (const t of st) {
      let m = 0;
      for (const h of ht) m = Math.max(m, t.length >= 4 && h.length >= 4 ? ratio(t, h) : t === h ? 1 : 0);
      sum += m;
    }
    const cover = sum / st.length;
    if (cover >= 0.75) best = Math.max(best, cover * 0.85 * Math.min(1, (st.length + 1) / (ht.length + 1)));
  }
  return Math.min(1, best);
}

export interface HeaderMatch {
  score: number;
  synonym: string;
  language: string;
}

/** Build a matcher over a synonym dictionary (defaults to the bundled one). */
export function createHeaderMatcher(dict: SynonymDictionary = synonymsJson as SynonymDictionary) {
  const entries: { field: CanonicalField; syn: string; lang: string }[] = [];
  for (const field of CANONICAL_FIELDS) {
    for (const [lang, list] of Object.entries(dict[field] ?? {})) {
      for (const s of list) entries.push({ field, syn: normalizeHeader(s), lang });
    }
  }
  return function match(header: string): Record<CanonicalField, HeaderMatch> {
    const h = normalizeHeader(header);
    const out = {} as Record<CanonicalField, HeaderMatch>;
    for (const f of CANONICAL_FIELDS) out[f] = { score: 0, synonym: '', language: '' };
    for (const e of entries) {
      const s = headerSimilarity(h, e.syn);
      if (s > out[e.field].score) out[e.field] = { score: s, synonym: e.syn, language: e.lang };
    }
    return out;
  };
}

export const matchHeader = createHeaderMatcher();
