/**
 * The per-holding attributes the app resolves and which TPT field(s) each one feeds.
 * Option lists come from the TPT spec (never hard-coded).
 */

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
  | 'interest_margin'
  | 'contract_size'
  | 'call_put'
  | 'strike'
  | 'exercise_type'
  | 'underlying_id'
  | 'underlying_id_type'
  | 'underlying_name'
  | 'underlying_price'
  | 'delta'
  | 'modified_duration'
  | 'valuation_yield'
  | 'underlying_category'
  | 'nace'
  | 'credit_sensitivity'
  | 'infrastructure'
  | 'counterparty_sector'
  | 'collateral_eligibility'
  | 'bail_in'
  | 'duration_to_call';

export type AttrKind = 'text' | 'number' | 'date' | 'code' | 'country' | 'currency' | 'cic' | 'nace';

export interface AttrDef {
  key: AttrKey;
  label: string;
  /** TPT field ids this attribute feeds (validated against the spec in tests). */
  tpt: string[];
  kind: AttrKind;
}

export const ATTRS: AttrDef[] = [
  { key: 'identifier', label: 'Identifier', tpt: ['14'], kind: 'text' },
  { key: 'id_type', label: 'Id type', tpt: ['15'], kind: 'code' },
  { key: 'name', label: 'Name', tpt: ['17'], kind: 'text' },
  { key: 'currency', label: 'Currency', tpt: ['21'], kind: 'currency' },
  { key: 'asset_class', label: 'Asset class', tpt: [], kind: 'text' },
  { key: 'cic', label: 'CIC', tpt: ['12'], kind: 'cic' },
  { key: 'quotation_zone', label: 'Quotation zone', tpt: ['13'], kind: 'code' },
  { key: 'quantity', label: 'Quantity', tpt: ['18'], kind: 'number' },
  { key: 'nominal', label: 'Nominal', tpt: ['19'], kind: 'number' },
  { key: 'price', label: 'Price', tpt: [], kind: 'number' },
  { key: 'fx_rate', label: 'FX rate', tpt: [], kind: 'number' },
  { key: 'accrued_local', label: 'Accrued interest (local)', tpt: [], kind: 'number' },
  { key: 'mv_local_dirty', label: 'MV incl. accrued (local)', tpt: ['22'], kind: 'number' },
  { key: 'mv_local_clean', label: 'MV clean (local)', tpt: ['23'], kind: 'number' },
  { key: 'mv_port_dirty', label: 'MV incl. accrued (portfolio)', tpt: ['24'], kind: 'number' },
  { key: 'mv_port_clean', label: 'MV clean (portfolio)', tpt: ['25'], kind: 'number' },
  { key: 'weight', label: 'Weight', tpt: ['26'], kind: 'number' },
  { key: 'interest_rate_type', label: 'Interest rate type', tpt: ['32'], kind: 'code' },
  { key: 'coupon', label: 'Coupon %', tpt: ['33'], kind: 'number' },
  { key: 'coupon_frequency', label: 'Coupon frequency', tpt: ['38'], kind: 'code' },
  { key: 'maturity', label: 'Maturity', tpt: ['39'], kind: 'date' },
  { key: 'redemption_type', label: 'Redemption type', tpt: ['40'], kind: 'code' },
  { key: 'redemption_rate', label: 'Redemption rate', tpt: ['41'], kind: 'number' },
  { key: 'callable', label: 'Callable/putable', tpt: ['42'], kind: 'code' },
  { key: 'call_date', label: 'Call/put date', tpt: ['43'], kind: 'date' },
  { key: 'issuer_name', label: 'Issuer', tpt: ['46'], kind: 'text' },
  { key: 'issuer_id', label: 'Issuer id (LEI)', tpt: ['47'], kind: 'text' },
  { key: 'issuer_id_type', label: 'Issuer id type', tpt: ['48'], kind: 'code' },
  { key: 'group_name', label: 'Issuer group', tpt: ['49'], kind: 'text' },
  { key: 'group_id', label: 'Group id (LEI)', tpt: ['50'], kind: 'text' },
  { key: 'group_id_type', label: 'Group id type', tpt: ['51'], kind: 'code' },
  { key: 'issuer_country', label: 'Issuer country', tpt: ['52'], kind: 'country' },
  { key: 'issuer_area', label: 'Issuer economic area', tpt: ['53'], kind: 'code' },
  { key: 'covered', label: 'Covered', tpt: ['55'], kind: 'code' },
  { key: 'securitisation', label: 'Securitisation', tpt: ['56'], kind: 'code' },
  { key: 'guarantee', label: 'State guarantee', tpt: ['57'], kind: 'code' },
  { key: 'subordinated', label: 'Subordinated', tpt: ['58'], kind: 'code' },
  { key: 'cqs', label: 'Credit quality step', tpt: ['59'], kind: 'code' },
  { key: 'credit_rating', label: 'Rating', tpt: ['112'], kind: 'text' },
  { key: 'rating_agency', label: 'Rating agency', tpt: ['113'], kind: 'text' },
  { key: 'interest_margin', label: 'Interest rate margin %', tpt: ['37'], kind: 'number' },
  { key: 'contract_size', label: 'Contract size', tpt: ['20'], kind: 'number' },
  { key: 'call_put', label: 'Call / put', tpt: ['60'], kind: 'code' },
  { key: 'strike', label: 'Strike', tpt: ['61'], kind: 'number' },
  { key: 'exercise_type', label: 'Exercise type', tpt: ['64'], kind: 'code' },
  { key: 'underlying_id', label: 'Underlying identifier', tpt: ['68'], kind: 'text' },
  { key: 'underlying_id_type', label: 'Underlying id type', tpt: ['69'], kind: 'code' },
  { key: 'underlying_name', label: 'Underlying', tpt: ['70'], kind: 'text' },
  { key: 'underlying_price', label: 'Underlying price', tpt: ['72'], kind: 'number' },
  { key: 'delta', label: 'Delta', tpt: ['93'], kind: 'number' },
  { key: 'modified_duration', label: 'Modified duration', tpt: ['90'], kind: 'number' },
  { key: 'valuation_yield', label: 'Valuation yield', tpt: ['129'], kind: 'number' },
  { key: 'underlying_category', label: 'Underlying category', tpt: ['131'], kind: 'code' },
  { key: 'nace', label: 'NACE', tpt: ['148'], kind: 'nace' },
  { key: 'credit_sensitivity', label: 'Credit sensitivity', tpt: ['92'], kind: 'number' },
  { key: 'infrastructure', label: 'Infrastructure investment', tpt: ['132'], kind: 'code' },
  { key: 'counterparty_sector', label: 'Counterparty sector', tpt: ['137'], kind: 'code' },
  { key: 'collateral_eligibility', label: 'Collateral eligibility', tpt: ['138'], kind: 'code' },
  { key: 'bail_in', label: 'Bail-in rule', tpt: ['142'], kind: 'code' },
  { key: 'duration_to_call', label: 'Modified duration to next call', tpt: ['91'], kind: 'number' },
];

export const ATTR: Record<AttrKey, AttrDef> = Object.fromEntries(ATTRS.map((a) => [a.key, a])) as Record<AttrKey, AttrDef>;

/** TPT NACE codification: section letter plus up to 4 digits, without dots (field 148 comment). */
export const isNaceFormat = (s: string) => /^[A-U](\d{1,4})?$/.test(s.trim().toUpperCase());

