/**
 * Whether the template asks for a field for an instrument with this CIC, down to the sub-category:
 * the applicability columns say "x" for a whole category, or "x for 52, 54" / "x for D1, D3" for
 * some sub-categories only. Used before deriving a value, so a rule never fills a field the template
 * does not ask for (a value from the file is never dropped by it).
 */
import { spec } from './index.ts';

const byId = new Map(spec.fields.map((f) => [f.id, f]));

export function fieldAppliesTo(fieldId: string, cic: string | undefined): boolean {
  const f = byId.get(fieldId);
  if (!f || !cic || cic.length !== 4) return false;
  const cols = f.cicApplicability as Record<string, string>;
  if (!Object.keys(cols).length) return true;
  const cat = cic[2].toUpperCase();
  const mark = cols[cat];
  if (!mark) return false;
  const only = /for\s+(.+)$/i.exec(mark.trim());
  if (!only) return true;
  // "52, 54", "62,64", "73, 74, 75", "D1, D3", "22": sub-category codes, with or without the category.
  const subs = only[1].split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const code = cic.slice(2).toUpperCase();
  return subs.some((x) => x === code || (x.length === 1 && x === code[1]));
}
