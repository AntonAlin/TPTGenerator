/**
 * Every value in the app carries where it came from. The TPT export and the
 * quality report rely on this to show, per cell, whether a value was taken
 * from the input file, the user's security master, entered by the user,
 * derived (with method and confidence), or left blank.
 */
export type Source = 'file' | 'master' | 'user' | 'derived' | 'missing';
export type Confidence = 'high' | 'medium' | 'low';

export type Scalar = string | number;

export interface Resolved<T extends Scalar = Scalar> {
  value?: T;
  source: Source;
  /** How the value was obtained, in plain words (always set for derived values). */
  method?: string;
  confidence?: Confidence;
  /** Extra context: assumptions, conflicts, why it is missing. */
  note?: string;
}

export const fromFile = <T extends Scalar>(value: T, method = 'Input file'): Resolved<T> => ({ value, source: 'file', method, confidence: 'high' });
export const fromMaster = <T extends Scalar>(value: T, method = 'Security master'): Resolved<T> => ({ value, source: 'master', method, confidence: 'high' });
export const fromUser = <T extends Scalar>(value: T, method = 'Entered by user'): Resolved<T> => ({ value, source: 'user', method, confidence: 'high' });
export const derived = <T extends Scalar>(value: T, method: string, confidence: Confidence, note?: string): Resolved<T> => ({
  value,
  source: 'derived',
  method,
  confidence,
  ...(note ? { note } : {}),
});
export const missing = (note?: string): Resolved<never> => ({ source: 'missing', ...(note ? { note } : {}) });

export const hasValue = <T extends Scalar>(r: Resolved<T> | undefined): r is Resolved<T> & { value: T } =>
  !!r && r.value !== undefined && r.value !== '';

/** Pick the first candidate that has a value (resolution order is the order of the arguments). */
export function firstOf<T extends Scalar>(...candidates: (Resolved<T> | undefined)[]): Resolved<T> {
  for (const c of candidates) if (hasValue(c)) return c;
  const notes = candidates.map((c) => c?.note).filter(Boolean);
  return missing(notes.join(' ') || undefined);
}

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
export const minConfidence = (...c: (Confidence | undefined)[]): Confidence =>
  (c.filter(Boolean) as Confidence[]).reduce<Confidence>((a, b) => (RANK[b] < RANK[a] ? b : a), 'high');
