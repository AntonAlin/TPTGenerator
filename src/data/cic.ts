/**
 * CIC (Complementary Identification Code) table and validation.
 * Data: src/data/cic_table.json, transcribed from spec/cic/cic_table_source.png.
 *
 * A CIC is 4 characters: [1-2] listing country (ISO 3166-1 alpha-2) or XL / XT,
 * [3] category, [4] sub-category within that category.
 */
import table from './cic_table.json';

export interface CicSubcategory { code: string; name: string }
export interface CicCategory { code: string; name: string; subcategories: CicSubcategory[] }

export const cicTable = table as {
  source: { description: string; file: string; transcribed: string; notes: string[] };
  positions12: { description: string; specialCodes: { code: string; label: string }[] };
  categories: CicCategory[];
};

const categories = new Map(cicTable.categories.map((c) => [c.code, c]));
const SPECIAL = new Set(cicTable.positions12.specialCodes.map((s) => s.code));

export type CicLocationKind = 'country' | 'XL' | 'XT';

export interface CicParseResult {
  valid: boolean;
  errors: string[];
  code: string;
  location?: string;
  locationKind?: CicLocationKind;
  category?: CicCategory;
  subcategory?: CicSubcategory;
}

/**
 * Validate the structure of a CIC code against the table. Whether the first two
 * letters are a real ISO 3166 country is checked by the caller once the ISO
 * country list is available (`isCountry` parameter).
 */
export function parseCic(raw: string, isCountry?: (code: string) => boolean): CicParseResult {
  const code = (raw ?? '').trim().toUpperCase();
  const errors: string[] = [];
  const result: CicParseResult = { valid: false, errors, code };
  if (!/^[A-Z]{2}[0-9A-F][0-9]$/.test(code)) {
    errors.push(`"${raw}" is not 2 letters + category (0-9, A-F) + sub-category digit.`);
    return result;
  }
  const loc = code.slice(0, 2);
  result.location = loc;
  result.locationKind = SPECIAL.has(loc) ? (loc as CicLocationKind) : 'country';
  if (result.locationKind === 'country' && isCountry && !isCountry(loc)) {
    errors.push(`"${loc}" is not an ISO 3166-1 alpha-2 country code, XL or XT.`);
  }
  const cat = categories.get(code[2]);
  if (!cat) {
    errors.push(`Category "${code[2]}" is not in the CIC table.`);
  } else {
    result.category = cat;
    const sub = cat.subcategories.find((s) => s.code === code[3]);
    if (!sub) errors.push(`Sub-category "${code[3]}" does not exist for category ${cat.code} (${cat.name}).`);
    else result.subcategory = sub;
  }
  result.valid = errors.length === 0;
  return result;
}

export function cicCategory(code: string): CicCategory | undefined {
  return categories.get(code.toUpperCase());
}

/** Build a CIC from parts; returns undefined if the combination is not in the table. */
export function buildCic(location: string, category: string, subcategory: string): string | undefined {
  const code = `${location}${category}${subcategory}`.toUpperCase();
  return parseCic(code).valid ? code : undefined;
}
