import regions from './regions.json';

const EEA = new Set(regions.eea);
const OECD = new Set(regions.oecd);

export const regionsAsOf = regions.asOf;

/**
 * TPT economic-zone code for a country: 1 = EEA, 2 = OECD excluding EEA, 3 = rest of the world.
 * Returns undefined for codes that are not countries (XA supranational, XS, …).
 */
export function economicZone(country: string | undefined): 1 | 2 | 3 | undefined {
  if (!country || !/^[A-Z]{2}$/.test(country)) return undefined;
  if (country === 'EU') return 1;
  if (EEA.has(country)) return 1;
  if (OECD.has(country)) return 2;
  if (country === 'XA' || country === 'XS' || country === 'XL' || country === 'XT') return undefined;
  return 3;
}
