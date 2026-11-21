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
