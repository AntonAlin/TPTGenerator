/**
 * The per-holding attributes the app resolves, which TPT field(s) each one
 * feeds, and which of them the user can maintain in the security master.
 * Option lists come from the TPT spec (never hard-coded).
 */
import { maybeField } from '../spec/index.ts';
import type { CodeListEntry } from '../spec/types.ts';

export type AttrKey =
  | 'identifier'
  | 'id_type'
  | 'name'
  | 'currency'
  | 'asset_class'
  | 'cic'
  | 'quotation_zone'
  | 'quantity'
  | 'nominal'
  | 'price'
  | 'fx_rate'
  | 'accrued_local'
  | 'mv_local_dirty'
  | 'mv_local_clean'
  | 'mv_port_dirty'
  | 'mv_port_clean'
  | 'weight'
  | 'interest_rate_type'
  | 'coupon'
  | 'coupon_frequency'
  | 'maturity'
  | 'redemption_type'
  | 'redemption_rate'
  | 'callable'
  | 'call_date'
  | 'issuer_name'
  | 'issuer_id'
  | 'issuer_id_type'
  | 'group_name'
  | 'group_id'
  | 'group_id_type'
  | 'issuer_country'
  | 'issuer_area'
  | 'covered'
  | 'securitisation'
  | 'guarantee'
  | 'subordinated'
  | 'cqs'
  | 'credit_rating'
  | 'rating_agency'
  | 'modified_duration'
  | 'valuation_yield'
  | 'underlying_category'
  | 'nace';

export type AttrKind = 'text' | 'number' | 'date' | 'code' | 'country' | 'currency' | 'cic' | 'nace';
export type MasterLevel = 'instrument' | 'issuer';

export interface AttrDef {
  key: AttrKey;
  label: string;
  /** TPT field ids this attribute feeds (validated against the spec in tests). */
  tpt: string[];
  kind: AttrKind;
  /** If set, the user can maintain this attribute in the security master at this level. */
  master?: MasterLevel;
  /** Show as a column in the security master grid. */
  grid?: boolean;
}

export const ATTRS: AttrDef[] = [
  { key: 'identifier', label: 'Identifier', tpt: ['14'], kind: 'text', master: 'instrument', grid: true },
  { key: 'id_type', label: 'Id type', tpt: ['15'], kind: 'code', master: 'instrument' },
  { key: 'name', label: 'Name', tpt: ['17'], kind: 'text', grid: true },
  { key: 'currency', label: 'Currency', tpt: ['21'], kind: 'currency' },
  { key: 'asset_class', label: 'Asset class', tpt: [], kind: 'text', grid: true },
  { key: 'cic', label: 'CIC', tpt: ['12'], kind: 'cic', master: 'instrument', grid: true },
  { key: 'quotation_zone', label: 'Quotation zone', tpt: ['13'], kind: 'code' },
  { key: 'quantity', label: 'Quantity', tpt: ['18'], kind: 'number' },
  { key: 'nominal', label: 'Nominal', tpt: ['19'], kind: 'number' },
  { key: 'price', label: 'Price', tpt: [], kind: 'number' },
  { key: 'fx_rate', label: 'FX rate', tpt: [], kind: 'number' },
  { key: 'accrued_local', label: 'Accrued interest (local)', tpt: [], kind: 'number' },
  { key: 'mv_local_dirty', label: 'MV incl. accrued (local)', tpt: ['22'], kind: 'number' },
  { key: 'mv_local_clean', label: 'MV clean (local)', tpt: ['23'], kind: 'number' },
  { key: 'mv_port_dirty', label: 'MV incl. accrued (portfolio)', tpt: ['24'], kind: 'number', grid: true },
  { key: 'mv_port_clean', label: 'MV clean (portfolio)', tpt: ['25'], kind: 'number' },
  { key: 'weight', label: 'Weight', tpt: ['26'], kind: 'number' },
  { key: 'interest_rate_type', label: 'Interest rate type', tpt: ['32'], kind: 'code', master: 'instrument' },
  { key: 'coupon', label: 'Coupon %', tpt: ['33'], kind: 'number', master: 'instrument', grid: true },
  { key: 'coupon_frequency', label: 'Coupon frequency', tpt: ['38'], kind: 'code', master: 'instrument' },
  { key: 'maturity', label: 'Maturity', tpt: ['39'], kind: 'date', master: 'instrument', grid: true },
  { key: 'redemption_type', label: 'Redemption type', tpt: ['40'], kind: 'code', master: 'instrument' },
  { key: 'redemption_rate', label: 'Redemption rate', tpt: ['41'], kind: 'number', master: 'instrument' },
  { key: 'callable', label: 'Callable/putable', tpt: ['42'], kind: 'code', master: 'instrument' },
  { key: 'call_date', label: 'Call/put date', tpt: ['43'], kind: 'date', master: 'instrument' },
  { key: 'issuer_name', label: 'Issuer', tpt: ['46'], kind: 'text', master: 'instrument', grid: true },
  { key: 'issuer_id', label: 'Issuer id (LEI)', tpt: ['47'], kind: 'text', master: 'issuer', grid: true },
  { key: 'issuer_id_type', label: 'Issuer id type', tpt: ['48'], kind: 'code', master: 'issuer' },
  { key: 'group_name', label: 'Issuer group', tpt: ['49'], kind: 'text', master: 'issuer', grid: true },
  { key: 'group_id', label: 'Group id (LEI)', tpt: ['50'], kind: 'text', master: 'issuer' },
  { key: 'group_id_type', label: 'Group id type', tpt: ['51'], kind: 'code', master: 'issuer' },
  { key: 'issuer_country', label: 'Issuer country', tpt: ['52'], kind: 'country', master: 'issuer', grid: true },
  { key: 'issuer_area', label: 'Issuer economic area', tpt: ['53'], kind: 'code' },
  { key: 'covered', label: 'Covered', tpt: ['55'], kind: 'code', master: 'instrument' },
  { key: 'securitisation', label: 'Securitisation', tpt: ['56'], kind: 'code', master: 'instrument' },
  { key: 'guarantee', label: 'State guarantee', tpt: ['57'], kind: 'code', master: 'instrument' },
  { key: 'subordinated', label: 'Subordinated', tpt: ['58'], kind: 'code', master: 'instrument' },
  { key: 'cqs', label: 'Credit quality step', tpt: ['59'], kind: 'code', master: 'instrument' },
  { key: 'credit_rating', label: 'Rating', tpt: ['112'], kind: 'text', master: 'instrument', grid: true },
  { key: 'rating_agency', label: 'Rating agency', tpt: ['113'], kind: 'text', master: 'instrument' },
  { key: 'modified_duration', label: 'Modified duration', tpt: ['90'], kind: 'number' },
  { key: 'valuation_yield', label: 'Valuation yield', tpt: ['129'], kind: 'number' },
  { key: 'underlying_category', label: 'Underlying category', tpt: ['131'], kind: 'code' },
  { key: 'nace', label: 'NACE', tpt: ['148'], kind: 'nace', master: 'issuer', grid: true },
];

export const ATTR: Record<AttrKey, AttrDef> = Object.fromEntries(ATTRS.map((a) => [a.key, a])) as Record<AttrKey, AttrDef>;

/** Closed list for a code attribute, read from the spec field it feeds. */
export function attrOptions(key: AttrKey): CodeListEntry[] | undefined {
  const def = ATTR[key];
  for (const id of def.tpt) {
    const f = maybeField(id);
    if (f?.codeList) return f.codeList;
  }
  return undefined;
}

/** TPT NACE codification: section letter plus up to 4 digits, without dots (field 148 comment). */
export const isNaceFormat = (s: string) => /^[A-U](\d{1,4})?$/.test(s.trim().toUpperCase());

/**
 * Whether an attribute feeds a mandatory TPT field that applies to this CIC category
 * (per the template's CIC applicability columns).
 */
export function isRequired(key: AttrKey, cic?: string): boolean {
  const id = ATTR[key].tpt[0];
  const f = id ? maybeField(id) : undefined;
  if (!f || f.requirement !== 'mandatory') return false;
  if (!cic || cic.length !== 4) return true;
  return !!f.cicApplicability[cic[2]];
}
