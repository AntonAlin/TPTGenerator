/**
 * Validate a value against a spec field's data type and closed list.
 * Rules come from the generated spec (data type, codification closed list,
 * max length) plus the bundled ISO/CIC tables.
 */
import { parseCic } from '../data/cic.ts';
import { isCountry, isTptCurrency } from '../data/iso.ts';
import { isNaceFormat } from '../master/attributes.ts';
import type { SpecField } from './types.ts';

export function validateFieldValue(f: SpecField, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim();
  switch (f.dataType) {
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return `${f.id}: "${s}" is not a YYYY-MM-DD date.`;
      return undefined;
    case 'number':
      return typeof value === 'number' || /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) ? undefined : `${f.id}: "${s}" is not a number.`;
    case 'integer':
      return /^-?\d+$/.test(s) ? undefined : `${f.id}: "${s}" is not an integer.`;
    case 'currency':
      return isTptCurrency(s) ? undefined : `${f.id}: "${s}" is not an ISO 4217 code or an extra code allowed by the template.`;
    case 'country': {
      // Field 52 explicitly allows XA (supranational) and EU (EU institutions).
      const extra = /\bXA\b/.test(f.comment) && /\bEU\b/.test(f.comment) ? ['XA', 'EU'] : [];
      return isCountry(s) || extra.includes(s) ? undefined : `${f.id}: "${s}" is not an ISO 3166-1 alpha-2 country code.`;
    }
    case 'cic': {
      const r = parseCic(s);
      return r.valid ? undefined : `${f.id}: ${r.errors.join(' ')}`;
    }
    case 'nace':
      return isNaceFormat(s) ? undefined : `${f.id}: "${s}" is not in NACE format (section letter plus up to 4 digits, no dots).`;
    case 'code':
      if (f.codeList && !f.codeList.some((c) => c.code === s)) return `${f.id}: "${s}" is not one of ${f.codeList.map((c) => c.code).join(', ')}.`;
      return undefined;
    case 'string':
      if (f.maxLength && s.length > f.maxLength) return `${f.id}: longer than ${f.maxLength} characters.`;
      return undefined;
    default:
      return undefined;
  }
}
