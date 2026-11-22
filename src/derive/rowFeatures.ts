/**
 * Features of one holding row for the row asset-class model (rowModel.ts): what the name says
 * (the name parser's hints plus the shorthand traders write: "ERIC B 70C", "OMX 2400P", "FESX Z6"),
 * which instrument terms the row carries (strike, contract size, delta, coupon, maturity), how its
 * amounts relate (quantity × price = value, nominal × price ÷ 100 = value, a value far below the
 * holding amount) and the identifier.
 *
 * The same function computes the training rows (scripts/row-training.ts) and the live rows, so
 * training and inference cannot drift apart.
 */
import type { FileValues } from './holdings.ts';
import { parseSecurityName, type NameHint, type ParsedName } from './parseName.ts';

const HINTS: NameHint[] = [
  'etf', 'fund', 'money_market', 'future', 'option', 'call', 'put', 'warrant', 'swap', 'cds', 'forward', 'cash', 'deposit',
  'government', 'supranational', 'regional', 'municipal', 'treasury_bill', 'covered', 'subordinated', 'hybrid', 'convertible',
  'commercial_paper', 'structured', 'securitised', 'bond', 'floating', 'inflation_linked', 'perpetual', 'preferred', 'right',
  'equity_class', 'real_estate', 'private_equity', 'infrastructure', 'equity_fund', 'debt_fund', 'mixed_fund', 'alternative_fund',
];

const CCY = 'USD|EUR|SEK|NOK|DKK|GBP|JPY|CHF|CAD|AUD|NZD|CNY|CNH|HKD|SGD|PLN|CZK|HUF|ISK|TRY|ZAR|MXN|BRL|INR|KRW';
const NAME_RE: [string, RegExp][] = [
  // "70C", "2400P", "C70", "P2400": option shorthand.
  ['n_strike_c', /\b\d+(?:[.,]\d+)?C\b|\bC\d+(?:[.,]\d+)?\b/],
  ['n_strike_p', /\b\d+(?:[.,]\d+)?P\b|\bP\d+(?:[.,]\d+)?\b/],
  // A month code with a short year: DEC26, MAR27, Z6, H27.
  ['n_month_year', /\b(JAN|FEB|MAR|APR|MAY|MAJ|JUN|JUL|AUG|SEP|OCT|OKT|NOV|DEC|DEZ)[- ]?\d{2}\b/i],
  ['n_futures_code', /\b[A-Z]{1,4}[FGHJKMNQUVXZ]\d{1,2}\b/],
  ['n_ccy_pair', new RegExp(`\\b(${CCY})\\s*[/-]?\\s*(${CCY})\\b`)],
  ['n_two_ccy', new RegExp(`\\b(${CCY})\\b.*\\b(${CCY})\\b`)],
  ['n_ccy_only', new RegExp(`^\\s*(${CCY})\\s*$`)],
  ['n_tenor', /\b\d{1,2} ?(Y|YR|YEAR|ÅR|J)\b/i],
  ['n_payer_receiver', /\b(PAY(ER)?|REC(EIVER)?|RECEIVE|FIXED\/FLOAT|FLOAT\/FIXED)\b/i],
  ['n_index', /\b(OMXS?\d*|STOXX|S&P|SPX|DAX|FTSE|NIKKEI|CAC|NASDAQ|MSCI|INDEX|NDX|SX5E|ES|NQ)\b/],
  ['n_percent', /\d\s?%/],
  ['n_year4', /\b20\d{2}\b/],
  ['n_date', /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}-[A-Z]{3}-\d{2,4}\b/i],
  ['n_share_class', /\b(ser\.?\s*)?[AB]\b|\b(PREF|SDB|ADR|GDR)\b/i],
  ['n_company', /\b(AB|AG|SA|SE|ASA|OYJ|A\/S|PLC|INC|CORP|LTD|NV|SPA|GMBH|HOLDING)\b/i],
  ['n_ucits', /\b(UCITS|SICAV|OEIC|ACC|DIST|INC)\b/i],
];

export const ROW_FEATURE_NAMES = [
  ...HINTS.map((h) => `h_${h}`),
  ...NAME_RE.map(([n]) => n),
  'name_none', 'name_digits', 'name_words', 'name_upper',
  'has_isin', 'isin_xs', 'isin_fund_domicile', 'isin_us', 'has_other_id', 'no_identifier',
  'has_coupon', 'coupon_zero', 'has_maturity', 'maturity_le_1y', 'maturity_le_60d', 'name_maturity', 'name_coupon',
  'has_price', 'price_is_1', 'price_50_150', 'price_lt_5', 'price_gt_1000', 'price_negative',
  'has_quantity', 'has_nominal', 'holding_negative', 'holding_integer', 'holding_round_100k',
  'has_mv', 'mv_zero', 'mv_negative', 'mv_far_below_holding', 'mv_equals_holding',
  'unit_priced', 'pct_priced', 'contract_priced',
  'has_strike', 'has_contract_size', 'has_call_put', 'call_put_put', 'has_delta', 'delta_negative', 'delta_one', 'delta_fraction',
  'has_underlying', 'has_underlying_price', 'has_rating', 'has_yield', 'has_duration', 'has_spread', 'has_accrued', 'has_issuer_lei',
] as const;

export type RowInput = Pick<
  FileValues,
  | 'security_name' | 'isin' | 'other_identifier' | 'quantity' | 'nominal' | 'market_value_local' | 'price' | 'coupon' | 'maturity_date'
  | 'contract_size' | 'strike' | 'call_put' | 'delta' | 'underlying_name' | 'underlying_id' | 'underlying_price' | 'rating' | 'yield'
  | 'modified_duration' | 'spread' | 'accrued_interest' | 'issuer_lei'
>;

const near = (a: number, b: number, rel = 0.005) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * rel);
const b = (x: boolean) => (x ? 1 : 0);

export function rowFeatures(f: RowInput, valuationDate?: string, parsed: ParsedName = parseSecurityName(f.security_name)): number[] {
  const name = f.security_name ?? '';
  const holding = f.quantity ?? f.nominal;
  const mv = f.market_value_local;
  const days = f.maturity_date && valuationDate ? (Date.parse(f.maturity_date) - Date.parse(valuationDate)) / 864e5 : undefined;
  const isin = f.isin?.toUpperCase();
  const cp = f.call_put?.trim().toLowerCase();
  const v: Record<string, number> = {};
  for (const h of HINTS) v[`h_${h}`] = b(parsed.hints.has(h));
  for (const [n, re] of NAME_RE) v[n] = b(re.test(name));
  Object.assign(v, {
    name_none: b(!name.trim()),
    name_digits: b(/\d/.test(name)),
    name_words: Math.min(name.trim().split(/\s+/).filter(Boolean).length, 8) / 8,
    name_upper: b(!!name && name === name.toUpperCase() && /[A-Z]/.test(name)),
    has_isin: b(!!isin),
    isin_xs: b(!!isin?.startsWith('XS')),
    isin_fund_domicile: b(!!isin && /^(LU|IE)/.test(isin)),
    isin_us: b(!!isin?.startsWith('US')),
    has_other_id: b(!!f.other_identifier),
    no_identifier: b(!isin && !f.other_identifier),
    has_coupon: b(f.coupon !== undefined),
    coupon_zero: b(f.coupon === 0),
    has_maturity: b(!!f.maturity_date),
    maturity_le_1y: b(days !== undefined && days <= 366),
    maturity_le_60d: b(days !== undefined && days <= 60),
    name_maturity: b(!!parsed.maturity || parsed.maturityYear !== undefined),
    name_coupon: b(parsed.coupon !== undefined),
    has_price: b(f.price !== undefined),
    price_is_1: b(f.price === 1),
    price_50_150: b(f.price !== undefined && f.price >= 50 && f.price <= 150),
    price_lt_5: b(f.price !== undefined && Math.abs(f.price) < 5),
    price_gt_1000: b(f.price !== undefined && f.price > 1000),
    price_negative: b(f.price !== undefined && f.price < 0),
    has_quantity: b(f.quantity !== undefined),
    has_nominal: b(f.nominal !== undefined),
    holding_negative: b(holding !== undefined && holding < 0),
    holding_integer: b(holding !== undefined && Number.isInteger(holding)),
    holding_round_100k: b(holding !== undefined && holding !== 0 && Math.abs(holding) % 100_000 === 0),
    has_mv: b(mv !== undefined),
    mv_zero: b(mv === 0),
    mv_negative: b(mv !== undefined && mv < 0),
    mv_far_below_holding: b(mv !== undefined && holding !== undefined && holding !== 0 && Math.abs(mv) < Math.abs(holding) * 0.05),
    mv_equals_holding: b(mv !== undefined && holding !== undefined && mv !== 0 && near(mv, holding, 1e-6)),
    unit_priced: b(mv !== undefined && holding !== undefined && f.price !== undefined && mv !== 0 && near(holding * f.price, mv)),
    pct_priced: b(mv !== undefined && holding !== undefined && f.price !== undefined && mv !== 0 && near((holding * f.price) / 100, mv)),
    contract_priced: b(mv !== undefined && holding !== undefined && f.price !== undefined && !!f.contract_size && f.contract_size !== 1 && mv !== 0 && near(holding * f.price * f.contract_size, mv)),
    has_strike: b(f.strike !== undefined),
    has_contract_size: b(f.contract_size !== undefined),
    has_call_put: b(!!cp),
    call_put_put: b(!!cp && /^(p|put|s[aä]lj|verkauf|vente)/.test(cp)),
    has_delta: b(f.delta !== undefined),
    delta_negative: b(f.delta !== undefined && f.delta < 0),
    delta_one: b(f.delta !== undefined && Math.abs(Math.abs(f.delta) - 1) < 1e-9),
    delta_fraction: b(f.delta !== undefined && Math.abs(f.delta) > 0 && Math.abs(f.delta) < 1),
    has_underlying: b(!!f.underlying_name || !!f.underlying_id),
    has_underlying_price: b(f.underlying_price !== undefined),
    has_rating: b(!!f.rating),
    has_yield: b(f.yield !== undefined),
    has_duration: b(f.modified_duration !== undefined),
    has_spread: b(f.spread !== undefined),
    has_accrued: b(f.accrued_interest !== undefined && f.accrued_interest !== 0),
    has_issuer_lei: b(!!f.issuer_lei),
  });
  return ROW_FEATURE_NAMES.map((n) => v[n] ?? 0);
}
