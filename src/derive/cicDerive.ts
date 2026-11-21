/**
 * Construct a 4-character CIC code: listing country (or XL / XT) + category + sub-category.
 *
 * Positions 1-2 come from, in order: the file's country column (assumed to be the
 * listing country, flagged as estimated), else the ISIN prefix (estimated — it is
 * the country of the numbering agency, not necessarily the listing or issuer),
 * else XL. Instruments that are not exchange tradable by nature (cash, deposits,
 * OTC derivatives) get XT. Non-ETF funds default to XL (not listed).
 */
import { parseCic } from '../data/cic.ts';
import { isCountry } from '../data/iso.ts';
import { economicZone } from '../data/regions.ts';
import { ASSET_CLASSES, type AssetClass } from './assetClass.ts';
import { derived, minConfidence, type Confidence, type Resolved } from './provenance.ts';

export interface CicInput {
  assetClass: AssetClass;
  assetClassConfidence: Confidence;
  isEtf: boolean;
  isin?: string;
  /** Country from the file's country column, if any. */
  fileCountry?: string;
}

export interface CicDerivation {
  cic: Resolved<string>;
  /** Other valid codes the user may want instead (same location, other sub-categories). */
  alternatives: string[];
  locationNote: string;
}

export function deriveCic(input: CicInput): CicDerivation {
  const info = ASSET_CLASSES[input.assetClass];
  let loc: string;
  let locConf: Confidence;
  let locationNote: string;

  if (!info.tradable) {
    loc = 'XT';
    locConf = 'high';
    locationNote = `${info.label}: not exchange tradable by nature → XT`;
  } else if (input.assetClass.startsWith('fund_') && !input.isEtf) {
    loc = 'XL';
    locConf = 'medium';
    locationNote = 'Fund not identified as an ETF → assumed not listed (XL). Use the listing country if the fund is exchange-listed.';
  } else if (input.fileCountry && isCountry(input.fileCountry)) {
    loc = input.fileCountry.toUpperCase();
    locConf = 'low';
    locationNote = `Country ${loc} from the file's country column, assumed to be the listing country (estimated)`;
  } else if (input.isin && isCountry(input.isin.slice(0, 2))) {
    loc = input.isin.slice(0, 2).toUpperCase();
    locConf = 'low';
    locationNote = `Country ${loc} from the ISIN prefix (estimated: the prefix is the numbering agency's country, not necessarily the listing country)`;
  } else {
    loc = 'XL';
    locConf = 'low';
    locationNote = input.isin
      ? `ISIN prefix ${input.isin.slice(0, 2)} is not a country; listing venue unknown → XL proposed, please confirm`
      : 'No listing information → XL proposed, please confirm';
  }

  const [cat, sub] = info.cic;
  const code = `${loc}${cat}${sub}`;
  const check = parseCic(code);
  if (!check.valid) throw new Error(`Internal error: built invalid CIC ${code}: ${check.errors.join(' ')}`);
  const subUncertain = (info.alternatives?.length ?? 0) > 0;
  const confidence = minConfidence(input.assetClassConfidence, locConf, subUncertain ? 'medium' : 'high');
  const alternatives = (info.alternatives ?? []).map((s) => `${loc}${cat}${s}`).filter((c) => parseCic(c).valid);
  const notes = [locationNote];
  if (subUncertain) notes.push(`Sub-category ${sub} (${check.subcategory?.name}) is the most likely option; alternatives: ${alternatives.join(', ')}.`);
  return {
    cic: derived(code, `Built from asset class "${info.label}" and listing location`, confidence, notes.join(' ')),
    alternatives,
    locationNote,
  };
}

/** TPT field 13: economic zone of the quotation place, mapped from CIC positions 1-2. */
export function quotationZoneFromCic(cic: string | undefined): Resolved<number> | undefined {
  if (!cic || cic.length !== 4) return undefined;
  const loc = cic.slice(0, 2);
  if (loc === 'XL' || loc === 'XT') return derived(0, `CIC ${cic}: ${loc} → non-listed (0)`, 'high');
  const z = economicZone(loc);
  return z ? derived(z, `CIC listing country ${loc} → economic zone ${z}`, 'high') : undefined;
}

/** TPT field 131: underlying asset category from the CIC category (equity split into listed 3L / unlisted 3X). */
export function underlyingCategoryFromCic(cic: string | undefined): Resolved<string> | undefined {
  if (!cic || cic.length !== 4) return undefined;
  const cat = cic[2];
  if (cat === '3') {
    const listed = cic.slice(0, 2) !== 'XL' && cic.slice(0, 2) !== 'XT';
    return derived(listed ? '3L' : '3X', `CIC ${cic}: equity, ${listed ? 'listed' : 'not listed'}`, 'high');
  }
  return derived(cat, `CIC ${cic}: category ${cat}`, 'high');
}
