/**
 * Asset type inference from the evidence available without reference data:
 * an asset-type column in the file, the section heading the row sat under,
 * keywords in the security name, coupon/maturity presence, price level and
 * the ISIN prefix. Produces one asset class with confidence, the evidence,
 * and the CIC category/sub-category it implies.
 */
import { parseSecurityName, type NameHint, type ParsedName } from './parseName.ts';
import type { Confidence } from './provenance.ts';

export type AssetClass =
  | 'equity'
  | 'equity_real_estate'
  | 'equity_right'
  | 'equity_preferred'
  | 'gov_bond'
  | 'supranational_bond'
  | 'regional_bond'
  | 'municipal_bond'
  | 'treasury_bill'
  | 'gov_covered_bond'
  | 'corporate_bond'
  | 'convertible_bond'
  | 'commercial_paper'
  | 'money_market_instrument'
  | 'hybrid_bond'
  | 'covered_bond'
  | 'subordinated_bond'
  | 'fund_equity'
  | 'fund_debt'
  | 'fund_money_market'
  | 'fund_allocation'
  | 'fund_real_estate'
  | 'fund_alternative'
  | 'fund_private_equity'
  | 'fund_infrastructure'
  | 'fund_other'
  | 'structured_note'
  | 'collateralised_security'
  | 'cash'
  | 'deposit_short'
  | 'deposit_long'
  | 'future'
  | 'call_option'
  | 'put_option'
  | 'warrant'
  | 'swap'
  | 'forward'
  | 'credit_derivative'
  | 'other';

export interface AssetClassInfo {
  label: string;
  /** CIC category (3rd character) and sub-category (4th). */
  cic: [string, string];
  /** Other plausible sub-categories within the same category, for the user to pick from. */
  alternatives?: string[];
  /** Whether instruments of this class are exchange tradable by nature (false → XT). */
  tradable: boolean;
  isFixedIncome?: boolean;
}

export const ASSET_CLASSES: Record<AssetClass, AssetClassInfo> = {
  equity: { label: 'Equity', cic: ['3', '1'], tradable: true },
  equity_real_estate: { label: 'Equity of real estate company', cic: ['3', '2'], tradable: true },
  equity_right: { label: 'Equity right', cic: ['3', '3'], tradable: true },
  equity_preferred: { label: 'Preferred equity', cic: ['3', '4'], tradable: true },
  gov_bond: { label: 'Government bond', cic: ['1', '1'], alternatives: ['5', '8'], tradable: true, isFixedIncome: true },
  supranational_bond: { label: 'Supranational bond', cic: ['1', '2'], tradable: true, isFixedIncome: true },
  regional_bond: { label: 'Regional government bond', cic: ['1', '3'], tradable: true, isFixedIncome: true },
  municipal_bond: { label: 'Municipal bond', cic: ['1', '4'], tradable: true, isFixedIncome: true },
  treasury_bill: { label: 'Treasury bill', cic: ['1', '5'], tradable: true, isFixedIncome: true },
  gov_covered_bond: { label: 'Government covered bond', cic: ['1', '6'], tradable: true, isFixedIncome: true },
  corporate_bond: { label: 'Corporate bond', cic: ['2', '1'], alternatives: ['8', '5', '9'], tradable: true, isFixedIncome: true },
  convertible_bond: { label: 'Convertible bond', cic: ['2', '2'], tradable: true, isFixedIncome: true },
  commercial_paper: { label: 'Commercial paper', cic: ['2', '3'], alternatives: ['4'], tradable: true, isFixedIncome: true },
  money_market_instrument: { label: 'Money market instrument', cic: ['2', '4'], alternatives: ['3'], tradable: true, isFixedIncome: true },
  hybrid_bond: { label: 'Hybrid bond', cic: ['2', '5'], alternatives: ['8'], tradable: true, isFixedIncome: true },
  covered_bond: { label: 'Covered bond', cic: ['2', '7'], alternatives: ['6'], tradable: true, isFixedIncome: true },
  subordinated_bond: { label: 'Subordinated bond', cic: ['2', '8'], alternatives: ['5'], tradable: true, isFixedIncome: true },
  fund_equity: { label: 'Equity fund', cic: ['4', '1'], alternatives: ['4', '9'], tradable: true },
  fund_debt: { label: 'Debt fund', cic: ['4', '2'], alternatives: ['3', '4'], tradable: true },
  fund_money_market: { label: 'Money market fund', cic: ['4', '3'], alternatives: ['2'], tradable: true },
  fund_allocation: { label: 'Asset allocation fund', cic: ['4', '4'], tradable: true },
  fund_real_estate: { label: 'Real estate fund', cic: ['4', '5'], tradable: true },
  fund_alternative: { label: 'Alternative fund', cic: ['4', '6'], tradable: true },
  fund_private_equity: { label: 'Private equity fund', cic: ['4', '7'], tradable: true },
  fund_infrastructure: { label: 'Infrastructure fund', cic: ['4', '8'], tradable: true },
  fund_other: { label: 'Fund (type unknown)', cic: ['4', '9'], alternatives: ['1', '2', '3', '4'], tradable: true },
  structured_note: { label: 'Structured note', cic: ['5', '9'], alternatives: ['1', '2', '3', '4'], tradable: true, isFixedIncome: true },
  collateralised_security: { label: 'Collateralised security', cic: ['6', '4'], alternatives: ['2', '5', '9'], tradable: true, isFixedIncome: true },
  cash: { label: 'Cash', cic: ['7', '1'], alternatives: ['2'], tradable: false },
  deposit_short: { label: 'Deposit ≤ 1 year', cic: ['7', '3'], tradable: false },
  deposit_long: { label: 'Deposit > 1 year', cic: ['7', '4'], tradable: false },
  future: { label: 'Future', cic: ['A', '9'], alternatives: ['1', '2', '3', '5'], tradable: true },
  call_option: { label: 'Call option', cic: ['B', '9'], alternatives: ['1', '2', '3', '5', '6'], tradable: true },
  put_option: { label: 'Put option', cic: ['C', '9'], alternatives: ['1', '2', '3', '5', '6'], tradable: true },
  warrant: { label: 'Warrant', cic: ['B', '4'], tradable: true },
  swap: { label: 'Swap', cic: ['D', '9'], alternatives: ['1', '2', '3', '4', '5'], tradable: false },
  forward: { label: 'Forward', cic: ['E', '9'], alternatives: ['1', '2'], tradable: false },
  credit_derivative: { label: 'Credit derivative', cic: ['F', '1'], alternatives: ['2', '3', '4', '9'], tradable: false },
  other: { label: 'Other investment', cic: ['0', '9'], tradable: false },
};

/** Keyword map for asset-type text found in a file column or a section heading (EN/SV/DE/FR). */
const TYPE_TEXT: [AssetClass, RegExp][] = [
  ['cash', /\b(cash|kassa|likvid(a|itet)?|bankguthaben|liquidit[ée]s?|bank|current account|kontokorrent)\b/i],
  ['deposit_short', /\b(deposit|inl[aå]ning|festgeld|d[ée]p[oô]t)/i],
  ['etf_marker' as AssetClass, /\betf\b/i],
  ['fund_money_market', /(money market|penningmarknad|geldmarkt|mon[ée]taire)/i],
  ['fund_other', /\b(funds?|fond(er|s)?|fondandelar|investment fund|mutual fund|ucits|opcvm|cis|ciu|etf|sicav)\b|fond\b/i],
  ['future', /\b(futures?|terminer|terminskontrakt)\b/i],
  ['forward', /\b(forwards?|fx forward|valutatermin(er)?|devisentermin\w*|fra)\b/i],
  ['swap', /\b(swaps?)\b/i],
  ['call_option', /\b(call|köpoption)/i],
  ['put_option', /\b(put|säljoption)/i],
  ['warrant', /\b(warrants?|optionsschein)/i],
  ['credit_derivative', /\b(cds|credit derivative)/i],
  ['covered_bond', /(covered|s[aä]kerst[aä]lld|pfandbrief|fonci[eè]re)/i],
  ['convertible_bond', /\b(convertible|konvertib\w*|wandel\w*)\b/i],
  ['treasury_bill', /\b(t-?bill|statsskuldv[aä]xel)/i],
  ['gov_bond', /\b(gov(ernmen)?t|sovereign|statsobligation(er)?|staatsanleihen?|obligations? d'[ée]tat|treasur(y|ies))\b/i],
  ['commercial_paper', /\b(commercial paper|f[oö]retagscertifikat|cp)\b/i],
  ['corporate_bond', /\b(corporate|f[oö]retagsobligation(er)?|unternehmensanleihen?|credit|frn|bonds?|obligation(er|s)?|anleihen?|renten|fixed income|r[aä]ntor|r[aä]ntebärande|fi)\b/i],
  ['equity_preferred', /\b(preferred|preferens\w*|vorzug\w*)\b/i],
  ['equity', /\b(equit(y|ies)|aktie[rn]?|stocks?|shares?|actions?|common stock|eq|listed equity)\b/i],
  ['structured_note', /\b(structured|strukturerad\w*|zertifikat\w*|certifikat)\b/i],
  ['other', /\b(other|övrigt|sonstige|autres)\b/i],
];

export interface AssetClassInput {
  name?: string;
  assetTypeText?: string;
  section?: string;
  isin?: string;
  hasCoupon?: boolean;
  hasMaturity?: boolean;
  price?: number;
  /** Quantity × price = market value in the file: priced per unit, not in % of nominal. */
  unitPriced?: boolean;
  /** Maturity date ISO, used to split short/long deposits. */
  maturity?: string;
  valuationDate?: string;
}

export interface AssetClassResult {
  assetClass: AssetClass;
  confidence: Confidence;
  evidence: string[];
  isEtf: boolean;
  parsedName: ParsedName;
  /** CIC sub-category implied by the derivative's underlying (e.g. FX forward → E2), when recognisable. */
  derivativeSub?: { sub: string; why: string };
}

/** Underlying-based CIC sub-categories for derivatives (categories A–F). */
const UNDERLYING: { re: RegExp; kind: 'equity' | 'rate' | 'fx' | 'commodity' | 'swaption' | 'irs' | 'ccs' | 'trs' | 'fra' | 'security_swap' }[] = [
  { re: /\bSWAPTION/i, kind: 'swaption' },
  { re: /\b(TRS|TOTAL RETURN)\b/i, kind: 'trs' },
  { re: /\b(CCS|CROSS[- ]CURRENCY|CCIRS)\b/i, kind: 'ccs' },
  { re: /\b(IRS|INTEREST RATE SWAP|OIS)\b/i, kind: 'irs' },
  { re: /\b(FRA|FORWARD RATE AGREEMENT)\b/i, kind: 'fra' },
  { re: /\b(FX|CURRENCY|VALUTA\w*|DEVISEN\w*)\b|\b[A-Z]{3}\/[A-Z]{3}\b/i, kind: 'fx' },
  { re: /\b(BUND|BOBL|SCHATZ|BUXL|T-?NOTE|T-?BOND|TREASURY|GILT|OAT|BTP|\d+ ?YR|EURIBOR|SOFR|SONIA|STIR|BOND|RATE)\b/i, kind: 'rate' },
  { re: /\b(OIL|BRENT|WTI|GOLD|SILVER|COPPER|GAS|COMMODIT\w*|WHEAT|CORN)\b/i, kind: 'commodity' },
  { re: /\b(OMXS?\d*|STOXX|S&P|SPX|DAX|FTSE|NIKKEI|CAC|NASDAQ|MSCI|INDEX|EQUITY|AKTIE\w*)\b/i, kind: 'equity' },
];
const SUB_BY_CLASS: Partial<Record<AssetClass, Partial<Record<(typeof UNDERLYING)[number]['kind'], string>>>> = {
  future: { equity: '1', rate: '2', fx: '3', commodity: '5' },
  call_option: { equity: '1', rate: '2', fx: '3', commodity: '5', swaption: '6' },
  put_option: { equity: '1', rate: '2', fx: '3', commodity: '5', swaption: '6' },
  swap: { irs: '1', ccs: '3', fx: '2', trs: '4', security_swap: '5' },
  forward: { fra: '1', fx: '2' },
};

function derivativeSub(cls: AssetClass, name: string | undefined): AssetClassResult['derivativeSub'] {
  const table = SUB_BY_CLASS[cls];
  if (!table || !name) return undefined;
  for (const u of UNDERLYING) {
    const m = u.re.exec(name);
    const sub = m && table[u.kind];
    if (sub) return { sub, why: `"${m[0]}" in the name → ${u.kind === 'fx' ? 'currency' : u.kind} underlying` };
  }
  return undefined;
}

function fromText(text: string | undefined): { cls?: AssetClass; etf: boolean; match?: string } {
  if (!text) return { etf: false };
  const etf = /\betf\b/i.test(text);
  for (const [cls, re] of TYPE_TEXT) {
    if (cls === ('etf_marker' as AssetClass)) continue;
    const m = re.exec(text);
    if (m) return { cls, etf, match: m[0] };
  }
  return { etf };
}

function fundSubtype(h: Set<NameHint>): AssetClass {
  if (h.has('money_market')) return 'fund_money_market';
  if (h.has('real_estate')) return 'fund_real_estate';
  if (h.has('private_equity')) return 'fund_private_equity';
  if (h.has('infrastructure')) return 'fund_infrastructure';
  if (h.has('alternative_fund')) return 'fund_alternative';
  if (h.has('mixed_fund')) return 'fund_allocation';
  if (h.has('debt_fund')) return 'fund_debt';
  if (h.has('equity_fund')) return 'fund_equity';
  return 'fund_other';
}

const isFund = (c: AssetClass) => c.startsWith('fund_');
const parsedHasBondTerms = (h: Set<NameHint>) => h.has('bond') || h.has('floating') || h.has('treasury_bill') || h.has('commercial_paper') || h.has('deposit');

/** Refine a broad class using name hints (e.g. bond → covered bond, fund → debt fund). */
function refine(base: AssetClass, h: Set<NameHint>, input: AssetClassInput): AssetClass {
  if (isFund(base)) return base === 'fund_other' ? fundSubtype(h) : base;
  if (['corporate_bond', 'gov_bond'].includes(base)) {
    if (h.has('securitised')) return 'collateralised_security';
    if (h.has('treasury_bill')) return 'treasury_bill';
    if (h.has('supranational')) return 'supranational_bond';
    if (h.has('covered')) return base === 'gov_bond' ? 'gov_covered_bond' : 'covered_bond';
    if (h.has('regional')) return 'regional_bond';
    if (h.has('municipal')) return 'municipal_bond';
    if (h.has('convertible')) return 'convertible_bond';
    if (h.has('hybrid')) return 'hybrid_bond';
    if (h.has('subordinated')) return 'subordinated_bond';
    if (h.has('commercial_paper')) return 'commercial_paper';
    if (h.has('government') && base === 'corporate_bond') return 'gov_bond';
  }
  if (base === 'equity') {
    if (h.has('preferred')) return 'equity_preferred';
    if (h.has('right')) return 'equity_right';
  }
  if (base === 'call_option' || base === 'put_option') return h.has('warrant') ? 'warrant' : base;
  if (base === 'deposit_short' && input.maturity && input.valuationDate) {
    const days = (Date.parse(input.maturity) - Date.parse(input.valuationDate)) / 864e5;
    if (days > 366) return 'deposit_long';
  }
  return base;
}

/** Infer the asset class from name, type text, section, structure and identifiers. */
export function inferAssetClass(input: AssetClassInput): AssetClassResult {
  const parsed = parseSecurityName(input.name);
  const h = parsed.hints;
  const evidence: string[] = [];
  const typeText = fromText(input.assetTypeText);
  const sectionText = fromText(input.section);
  const isEtf = h.has('etf') || typeText.etf || sectionText.etf;
  const fixedIncomeShape = !!(input.hasCoupon && input.hasMaturity);

  const done = (cls: AssetClass, confidence: Confidence): AssetClassResult => {
    const refined = refine(cls, h, input);
    if (refined !== cls) evidence.push(`Name keywords refine it to ${ASSET_CLASSES[refined].label.toLowerCase()}`);
    if (isEtf) evidence.push('ETF: classified as a collective investment undertaking (CIC 4x)');
    const sub = derivativeSub(refined, input.name);
    if (sub) evidence.push(sub.why);
    return { assetClass: refined, confidence, evidence, isEtf, parsedName: parsed, ...(sub ? { derivativeSub: sub } : {}) };
  };

  // 1. Explicit asset-type column in the file.
  if (typeText.cls) {
    evidence.push(`Asset type "${input.assetTypeText}" in the file (matched "${typeText.match}")`);
    let cls = typeText.cls;
    if (isEtf) cls = fundSubtype(h);
    // Generic "bond"/"fixed income" text plus government hints → government bond.
    if (cls === 'corporate_bond' && h.has('government')) cls = 'gov_bond';
    if (cls === 'corporate_bond' && !fixedIncomeShape && !h.has('bond') && !h.has('floating') && (h.has('fund') || isEtf)) cls = fundSubtype(h);
    return done(cls, cls === 'corporate_bond' && !/corporate|f[oö]retag|unternehmen/i.test(input.assetTypeText ?? '') ? 'medium' : 'high');
  }

  // 2. Strong name keywords.
  const nameRules: [boolean, AssetClass, Confidence, string][] = [
    [isEtf || h.has('fund'), fundSubtype(h), isEtf || h.has('fund') ? 'high' : 'medium', 'fund/ETF keyword in name'],
    [h.has('money_market') && !fixedIncomeShape && !parsedHasBondTerms(h), 'fund_money_market', 'medium', 'money market fund keyword in name'],
    [h.has('cash'), 'cash', 'high', 'cash keyword in name'],
    [h.has('deposit'), 'deposit_short', 'medium', 'deposit keyword in name'],
    [h.has('cds'), 'credit_derivative', 'high', 'CDS keyword in name'],
    [h.has('swap'), 'swap', 'high', 'swap keyword in name'],
    [h.has('forward'), 'forward', 'high', 'forward keyword in name'],
    [h.has('future'), 'future', 'high', 'future keyword in name'],
    [h.has('warrant'), 'warrant', 'high', 'warrant keyword in name'],
    [h.has('call') && h.has('option'), 'call_option', 'high', 'call option keywords in name'],
    [h.has('put') && h.has('option'), 'put_option', 'high', 'put option keywords in name'],
    [h.has('structured'), 'structured_note', 'medium', 'structured product keyword in name'],
    [h.has('securitised'), 'collateralised_security', 'medium', 'ABS/MBS keyword in name'],
    [h.has('treasury_bill'), 'treasury_bill', 'high', 'treasury bill keyword in name'],
    [h.has('commercial_paper') && (fixedIncomeShape || !!parsed.maturity), 'commercial_paper', 'medium', 'commercial paper keyword in name'],
  ];
  for (const [cond, cls, conf, why] of nameRules) {
    if (cond) {
      evidence.push(why);
      return done(cls, conf);
    }
  }

  // 3. Section heading in the file ("Aktier", "Obligationer", …).
  if (sectionText.cls) {
    evidence.push(`Listed under section "${input.section}"`);
    let cls = sectionText.cls;
    if (cls === 'corporate_bond' && h.has('government')) cls = 'gov_bond';
    return done(cls, 'medium');
  }

  // 4. Structure: coupon + maturity, or bond-like name, or bond-like price.
  const bondLike = fixedIncomeShape || !!parsed.maturity || parsed.coupon !== undefined || h.has('floating') || h.has('bond') || h.has('perpetual');
  if (bondLike) {
    if (fixedIncomeShape) evidence.push('Has coupon and maturity');
    if (parsed.coupon || parsed.maturity) evidence.push('Name contains coupon and/or maturity');
    if (h.has('floating')) evidence.push('Floating-rate keyword in name');
    const gov = h.has('government') || h.has('supranational') || h.has('regional') || h.has('municipal');
    if (gov) evidence.push('Government/public-sector issuer keyword in name');
    const conf: Confidence = (parsed.coupon || fixedIncomeShape) && (parsed.maturity || input.hasMaturity) ? 'medium' : 'low';
    return done(gov ? 'gov_bond' : 'corporate_bond', conf);
  }
  if (input.isin?.startsWith('XS')) {
    evidence.push('XS (international) ISIN prefix is typical for bonds');
    return done('corporate_bond', 'low');
  }
  if (h.has('equity_class') || h.has('preferred') || h.has('right')) {
    evidence.push('Company name / share class pattern in name');
    return done('equity', input.isin ? 'medium' : 'low');
  }
  if (input.isin && input.price !== undefined && !(input.price >= 70 && input.price <= 130)) {
    evidence.push('Has an ISIN, no coupon/maturity, price not bond-like');
    return done('equity', 'low');
  }
  if (input.isin && input.unitPriced) {
    evidence.push('Has an ISIN, no coupon/maturity, quantity × price = market value (priced per unit, not in % of nominal)');
    return done('equity', 'low');
  }
  evidence.push('No usable evidence');
  return { assetClass: 'other', confidence: 'low', evidence, isEtf, parsedName: parsed };
}
