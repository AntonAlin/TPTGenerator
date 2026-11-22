/**
 * Benchmark holdings: a random but realistic portfolio with the full answer key, richer than
 * scripts/random-portfolio.ts (coupons, maturities, ratings, durations, option and future terms),
 * so that every field the converter may fill can be scored. Deterministic per seed.
 */

export type Kind =
  | 'equity' | 'gov_bond' | 'corp_bond' | 'covered' | 'frn' | 'tbill' | 'fund' | 'etf' | 'cash'
  | 'forward' | 'future' | 'option' | 'irs';

export interface BenchHolding {
  name: string;
  isin?: string;
  ticker?: string;
  issuer?: string;
  kind: Kind;
  /** Quotation currency. */
  currency: string;
  country: string;
  /** What the "holding" amount is: shares/units, a nominal, a cash balance, a notional or contracts. */
  holdingIs: 'quantity' | 'nominal' | 'cash' | 'notional' | 'contracts';
  holding: number;
  /** Price per unit, or % of nominal for bonds; option premium per underlying unit. */
  price?: number;
  /** Clean market value in quotation and portfolio currency. */
  mvLocal: number;
  mvPortfolio: number;
  accruedLocal?: number;
  coupon?: number;
  maturity?: string;
  rating?: string;
  modifiedDuration?: number;
  yieldPct?: number;
  contractSize?: number;
  strike?: number;
  callPut?: 'call' | 'put';
  underlying?: string;
  underlyingPrice?: number;
  delta?: number;
  /** A forward's legs: bought (received) and sold (paid), consistent with its market value. */
  legs?: { buy: { ccy: string; amount: number }; sell: { ccy: string; amount: number } };
  /** Expected CIC category (3rd character of the CIC). */
  cicCategory: string;
  /** The file shows the notional in the market value columns (only a total row gives it away). */
  notionalShownAsValue?: boolean;
  assetType: string;
}

export interface BenchPortfolio {
  seed: number;
  base: string;
  fx: Record<string, number>;
  holdings: BenchHolding[];
  /** Sum of the true portfolio-currency values. */
  total: number;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isin(prefix: string, body: string): string {
  const payload = prefix + body;
  const digits = [...payload].map((c) => parseInt(c, 36).toString()).join('');
  let sum = 0;
  [...digits].reverse().forEach((ch, i) => {
    let v = Number(ch);
    if (i % 2 === 0) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  });
  return payload + ((10 - (sum % 10)) % 10);
}

export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const FX_SEK: Record<string, number> = { SEK: 1, EUR: 11.5, USD: 10.5, NOK: 0.98, DKK: 1.54, GBP: 13.3, CHF: 12.1 };
const EQUITY_COUNTRIES: [string, string][] = [['SE', 'SEK'], ['SE', 'SEK'], ['DE', 'EUR'], ['FR', 'EUR'], ['US', 'USD'], ['US', 'USD'], ['GB', 'GBP'], ['NO', 'NOK'], ['FI', 'EUR'], ['DK', 'DKK'], ['CH', 'CHF']];
const SOVEREIGNS: [string, string, string][] = [['SE', 'SEK', 'SWEDEN'], ['DE', 'EUR', 'BUND'], ['FR', 'EUR', 'FRANCE OAT'], ['US', 'USD', 'UST'], ['GB', 'GBP', 'UKT']];
const SYL = ['nor', 'vik', 'sand', 'berg', 'atl', 'tel', 'gen', 'ax', 'lux', 'mar', 'tor', 'ika', 'lun', 'ess', 'kin', 'ro', 'max', 'tri', 'on', 'ex', 'vol', 'dal', 'fen', 'mo'];
const SUFFIX: Record<string, string[]> = { SE: ['AB', 'AB ser. B'], DE: ['AG', 'SE'], FR: ['SA'], US: ['Inc', 'Corp'], GB: ['plc'], NO: ['ASA'], FI: ['Oyj'], DK: ['A/S'], CH: ['AG'] };
const RATINGS = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB'];

export interface HoldingOptions {
  /** Portfolio currency (default: SEK or EUR from the seed). */
  base?: string;
  /** Include options and interest rate swaps (default true). */
  exotic?: boolean;
  /** Price drift for a later date of the same portfolio (default 0). */
  drift?: number;
}

/** Year fraction for a simple duration approximation. */
const years = (iso: string, from = '2026-09-30') => (Date.parse(iso) - Date.parse(from)) / (365.25 * 864e5);

export function generateHoldings(seed: number, opts: HoldingOptions = {}): BenchPortfolio {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('');
  const company = () => {
    const n = Array.from({ length: int(2, 3) }, () => pick(SYL)).join('');
    return n[0].toUpperCase() + n.slice(1);
  };
  const base = opts.base ?? pick(['SEK', 'EUR'] as const);
  const fx: Record<string, number> = Object.fromEntries(Object.entries(FX_SEK).map(([c, v]) => [c, v / FX_SEK[base]]));
  const drift = 1 + (opts.drift ?? 0);
  const h: BenchHolding[] = [];
  const usedNames = new Set<string>();
  const unique = (n: string) => {
    let name = n;
    for (let i = 2; usedNames.has(name); i++) name = `${n} ${i}`;
    usedNames.add(name);
    return name;
  };

  for (let i = 0, n = int(5, 12); i < n; i++) {
    const [cc, ccy] = pick(EQUITY_COUNTRIES);
    const co = company();
    const qty = int(1, 400) * pick([10, 50, 100]);
    const price = round(pick([5 + rnd() * 50, 40 + rnd() * 400, 200 + rnd() * 2500]) * drift, 2);
    h.push({ name: unique(`${co} ${pick(SUFFIX[cc])}`), isin: isin(cc, digits(9)), ticker: co.slice(0, 4).toUpperCase(), issuer: co, kind: 'equity', currency: ccy, country: cc, holdingIs: 'quantity', holding: qty, price, mvLocal: round(qty * price), mvPortfolio: 0, cicCategory: '3', assetType: 'Equity' });
  }
  const dateIn = (y0: number, y1: number) => {
    const y = int(y0, y1);
    return `${y}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
  };
  const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  for (let i = 0, n = int(3, 8); i < n; i++) {
    const kind = pick(['gov_bond', 'gov_bond', 'corp_bond', 'corp_bond', 'covered', 'frn'] as const);
    const nominal = int(1, 50) * 100_000;
    const cpn = pick([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.25, 4, 4.5, 5]);
    const maturity = dateIn(2027, 2040);
    let name: string;
    let cc: string;
    let ccy: string;
    let issuer: string;
    if (kind === 'gov_bond') {
      const s = pick(SOVEREIGNS);
      [cc, ccy, issuer] = [s[0], s[1], s[2]];
      name = `${s[2]} ${cpn}% ${dmy(maturity)}`;
    } else if (kind === 'covered') {
      [cc, ccy] = pick([['SE', 'SEK'], ['DK', 'DKK'], ['DE', 'EUR']] as const);
      issuer = `${company().toUpperCase()} HYPOTEK`;
      name = `${issuer} COVERED ${cpn}% ${dmy(maturity)}`;
    } else {
      [cc, ccy] = pick(EQUITY_COUNTRIES);
      issuer = `${company().toUpperCase()} ${pick(SUFFIX[cc]).toUpperCase()}`;
      name = kind === 'frn' ? `${issuer} FRN ${maturity.slice(0, 4)}` : `${issuer} ${cpn}% ${dmy(maturity)}`;
    }
    const price = round((kind === 'frn' ? 99 + rnd() * 2 : 85 + rnd() * 25) * drift, 3);
    const t = years(maturity);
    const yld = round(kind === 'frn' ? 3 + rnd() : cpn + (100 - price) / Math.max(t, 0.5), 3);
    h.push({
      name: unique(name), isin: isin(rnd() < 0.3 && kind !== 'gov_bond' ? 'XS' : cc, digits(9)), issuer, kind, currency: ccy, country: cc,
      holdingIs: 'nominal', holding: nominal, price, mvLocal: round((nominal * price) / 100), mvPortfolio: 0,
      accruedLocal: kind === 'frn' ? undefined : round((nominal * cpn) / 100 * rnd(), 2),
      coupon: kind === 'frn' ? undefined : cpn, maturity, rating: kind === 'gov_bond' ? pick(['AAA', 'AA+', 'AA']) : pick(RATINGS),
      modifiedDuration: kind === 'frn' ? round(0.1 + rnd() * 0.15, 3) : round(t / (1 + yld / 100), 3), yieldPct: yld,
      cicCategory: kind === 'gov_bond' ? '1' : '2', assetType: kind === 'gov_bond' ? 'Government bond' : kind === 'covered' ? 'Covered bond' : kind === 'frn' ? 'Floating rate note' : 'Corporate bond',
    });
  }
  if (rnd() < 0.5) {
    const nominal = int(5, 50) * 1_000_000;
    const maturity = `2027-0${int(1, 3)}-${String(int(10, 28))}`;
    const price = round(98.5 + rnd(), 4);
    h.push({ name: unique(`${base === 'SEK' ? 'SWEDISH' : 'GERMAN'} T-BILL ${dmy(maturity)}`), isin: isin(base === 'SEK' ? 'SE' : 'DE', digits(9)), kind: 'tbill', currency: base, country: base === 'SEK' ? 'SE' : 'DE', holdingIs: 'nominal', holding: nominal, price, mvLocal: round((nominal * price) / 100), mvPortfolio: 0, maturity, cicCategory: '1', assetType: 'Money market / T-bill' });
  }
  for (let i = 0, n = int(1, 4); i < n; i++) {
    const etf = rnd() < 0.4;
    const ccy = pick(['SEK', 'EUR', 'USD'] as const);
    const name = etf ? `${company()} MSCI World UCITS ETF ${ccy}` : `${company()} ${pick(['Global Equity', 'Short Bond', 'Sverige', 'Europa', 'High Yield'])} Fund ${pick(['A', 'I', 'B'])}`;
    const units = round(100 + rnd() * 50_000, 4);
    const price = round((10 + rnd() * 300) * drift, 4);
    h.push({ name: unique(name), isin: isin(pick(['LU', 'IE', 'SE']), digits(9)), kind: etf ? 'etf' : 'fund', currency: ccy, country: 'LU', holdingIs: 'quantity', holding: units, price, mvLocal: round(units * price), mvPortfolio: 0, cicCategory: '4', assetType: etf ? 'ETF' : 'Mutual fund' });
  }
  for (const ccy of [base, ...(rnd() < 0.6 ? ['USD'] : [])]) {
    const amount = round(int(50, 5000) * 1000 + rnd() * 1000);
    h.push({ name: unique(`Cash ${ccy}`), kind: 'cash', currency: ccy, country: '', holdingIs: 'cash', holding: amount, mvLocal: amount, mvPortfolio: 0, cicCategory: '7', assetType: 'Cash' });
  }
  const forwards = int(0, 2);
  for (let i = 0; i < forwards; i++) {
    const notional = int(1, 40) * 100_000;
    h.push({ name: unique(`FX FWD ${base}/USD ${['15-DEC-2026', '17-MAR-2027'][i]}`), ticker: `FWD-${digits(4)}`, kind: 'forward', currency: 'USD', country: '', holdingIs: 'notional', holding: notional, mvLocal: round((rnd() - 0.5) * notional * 0.02), mvPortfolio: 0, maturity: ['2026-12-15', '2027-03-17'][i], cicCategory: 'E', assetType: 'FX forward' });
  }
  if (rnd() < 0.6) {
    const contracts = int(1, 30) * (rnd() < 0.3 ? -1 : 1);
    const level = round((4500 + rnd() * 800) * drift, 1);
    h.push({ name: unique(`EURO STOXX 50 FUT ${pick(['DEC26', 'MAR27'])}`), ticker: `FUT-${digits(4)}`, kind: 'future', currency: 'EUR', country: '', holdingIs: 'contracts', holding: contracts, price: level, mvLocal: 0, mvPortfolio: 0, contractSize: 10, underlying: 'EURO STOXX 50', underlyingPrice: level, delta: 1, maturity: '2026-12-18', cicCategory: 'A', assetType: 'Future' });
  }
  if (opts.exotic !== false && rnd() < 0.6) {
    const callPut = rnd() < 0.5 ? 'call' : 'put';
    const level = round(2400 + rnd() * 400, 1);
    const strike = Math.round(level / 50) * 50 + (callPut === 'call' ? 100 : -100);
    const premium = round(10 + rnd() * 60, 2);
    const contracts = int(10, 400);
    h.push({ name: unique(`OMXS30 ${callPut === 'call' ? 'Call' : 'Put'} ${strike} DEC26`), ticker: `OPT-${digits(4)}`, kind: 'option', currency: 'SEK', country: 'SE', holdingIs: 'contracts', holding: contracts, price: premium, mvLocal: round(contracts * 100 * premium), mvPortfolio: 0, contractSize: 100, strike, callPut, underlying: 'OMXS30', underlyingPrice: level, delta: round(callPut === 'call' ? 0.2 + rnd() * 0.4 : -0.2 - rnd() * 0.4, 3), maturity: '2026-12-18', cicCategory: callPut === 'call' ? 'B' : 'C', assetType: 'Option' });
  }
  if (opts.exotic !== false && rnd() < 0.4) {
    const notional = int(1, 10) * 10_000_000;
    h.push({ name: unique(`${base} ${int(2, 10)}Y PAYER IRS`), ticker: `IRS-${digits(4)}`, kind: 'irs', currency: base, country: '', holdingIs: 'notional', holding: notional, mvLocal: round((rnd() - 0.5) * notional * 0.03), mvPortfolio: 0, maturity: dateIn(2028, 2036), cicCategory: 'D', assetType: 'Interest rate swap' });
  }
  for (const r of h) r.mvPortfolio = round(r.mvLocal * fx[r.currency]);
  // Forwards buy the base currency and sell USD; the bought leg is what makes the value come out.
  for (const r of h) if (r.kind === 'forward') r.legs = { buy: { ccy: base, amount: round(r.mvPortfolio + r.holding * fx.USD) }, sell: { ccy: 'USD', amount: r.holding } };
  // A forward whose notional is shown as its market value (only a total row gives it away).
  if (forwards > 0 && rnd() < 0.5) h.find((r) => r.kind === 'forward')!.notionalShownAsValue = true;
  const total = round(h.reduce((a, r) => a + r.mvPortfolio, 0));
  return { seed, base, fx, holdings: h, total };
}
