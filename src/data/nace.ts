/**
 * NACE picklist (codes in TPT field 148 format: section letter + digits, no dots).
 * Used only for validation and user selection — NACE codes are never guessed from names.
 */
import nace from './nace.json';

export interface NaceItem {
  code: string;
  nace: string;
  level: 'section' | 'division' | 'group' | 'class';
  section: string;
  label: string;
  supplement?: string;
}

export const naceItems = nace.items as NaceItem[];
export const naceClassification = nace.classification;
const byCode = new Map(naceItems.map((i) => [i.code, i]));

export const naceLookup = (code: string): NaceItem | undefined => byCode.get(code.trim().toUpperCase());

/**
 * A NACE code as files write it ("K64.1.9", "64.19", "64.19Z" in the French NAF, "C29.1", "K") in TPT
 * field 148 format ("K6419"), or undefined when it is not a NACE code. Only reformats; never guesses.
 */
export function normalizeNace(raw: string): string | undefined {
  const t = raw.trim().toUpperCase().replace(/[.\s]/g, '');
  const m = /^([A-U]?)(\d{0,4})([A-Z]?)$/.exec(t);
  if (!m) return undefined;
  const [, letter, digits, suffix] = m;
  if (suffix && !digits) return undefined;
  if (!digits) return naceLookup(letter) ? letter : undefined;
  // The section follows from the division when the file leaves the letter out.
  const item = letter ? naceLookup(letter + digits) : naceItems.find((i) => i.code.slice(1) === digits);
  return item?.code;
}
