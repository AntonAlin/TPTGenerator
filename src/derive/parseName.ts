/**
 * Extract coupon, maturity and instrument hints from free-text security names,
 * e.g. "SWEDEN 0.75% 12/11/2029", "UST 4 1/8 15-NOV-32", "XYZ AB FRN 2027",
 * "BUND 0 02/15/31", "iShares Core MSCI World UCITS ETF".
 *
 * Every extracted value carries a confidence and the matched text as evidence.
 */
import type { Confidence } from './provenance.ts';
import { isoDate } from '../ingest/values.ts';
import { countries } from '../data/iso.ts';

/** Upper-case country names (and common short forms) for "SWEDEN 0.75% 2029"-style sovereign names. */
const COUNTRY_NAMES = [
  ...countries.map((c) => c.name.toUpperCase().replace(/,.*$/, '')),
  'SVERIGE', 'DEUTSCHLAND', 'FRANKRIKE', 'ITALIA', 'ESPANA', 'BELGIUM', 'NETHERLANDS', 'AUSTRIA', 'NORGE', 'DANMARK', 'SUOMI',
  'UNITED KINGDOM', 'UK', 'USA', 'US',
].sort((a, b) => b.length - a.length);

export type NameHint =
  | 'etf'
  | 'fund'
  | 'money_market'
  | 'future'
  | 'option'
  | 'call'
  | 'put'
  | 'warrant'
  | 'swap'
  | 'cds'
  | 'forward'
  | 'cash'
  | 'deposit'
  | 'government'
  | 'supranational'
  | 'regional'
  | 'municipal'
  | 'treasury_bill'
  | 'covered'
  | 'subordinated'
  | 'hybrid'
  | 'convertible'
  | 'commercial_paper'
  | 'structured'
  | 'securitised'
  | 'bond'
  | 'floating'
  | 'inflation_linked'
  | 'perpetual'
  | 'preferred'
  | 'right'
  | 'equity_class'
  | 'real_estate'
  | 'private_equity'
  | 'infrastructure'
  | 'equity_fund'
  | 'debt_fund'
  | 'mixed_fund'
  | 'alternative_fund';

export interface ParsedName {
  coupon?: { value: number; confidence: Confidence; text: string };
  maturity?: { value: string; confidence: Confidence; text: string; note?: string };
  /** Year only, when the name gives no full date (e.g. "FRN 2027"). Not a maturity date. */
  maturityYear?: number;
  hints: Set<NameHint>;
  evidence: string[];
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  MAJ: 5, OKT: 10, MAI: 5, DEZ: 12, MRZ: 3,
};

const HINT_PATTERNS: [NameHint, RegExp][] = [
  ['etf', /\b(ETF|ETC|UCITS ETF|EXCHANGE TRADED)\b/i],
  ['fund', /\b(FUNDS?|FONDS|SICAV|UCITS|OEIC|FCP|INVESTMENTFONDS|ANDELSKLASS|UNIT TRUST)\b|FOND(EN|ER|S)?\b/i],
  ['money_market', /\b(MONEY MARKET|MON[EÉ]TAIRE|LIQUIDITY FUND|KORT R[AÄ]NTA)\b|PENNINGMARKNAD|GELDMARKT|KORTR[AÄ]NTE/i],
  ['future', /\b(FUT|FUTURES?|TERMINSKONTRAKT|FUTURE CONTRACT)\b/i],
  ['option', /\b(OPT|OPTIONS?|OPTION)\b/i],
  ['call', /\b(CALL|KÖPOPTION)\b/i],
  ['put', /\b(PUT|SÄLJOPTION)\b/i],
  ['warrant', /\b(WARRANTS?|WRT|OPTIONSSCHEIN|TURBO|MINI FUTURE)\b/i],
  ['cds', /\b(CDS|CREDIT DEFAULT SWAP)\b/i],
  ['swap', /\b(SWAP|IRS|CCS|TRS|SWAPTION)\b/i],
  ['forward', /\b(FWD|FORWARD|FX FORWARD|VALUTATERMIN|DEVISENTERMIN|FRA|NDF|TERMIN)\b/i],
  ['cash', /\b(CASH|KASSA|LIKVIDA MEDEL|LIKVIDA|BANKGUTHABEN|LIQUIDIT[EÉ]S?|BANK ACCOUNT|BANKKONTO|CURRENT ACCOUNT|KONTOKORRENT)\b/i],
  ['deposit', /\b(DEPOSITS?|INL[AÅ]NING|TERMINSDEPOSITION|FESTGELD|TIME DEPOSIT|D[EÉ]P[OÔ]T [AÀ] TERME|CALL DEPOSIT)\b/i],
  ['treasury_bill', /\b(T-?BILLS?|TREASURY BILLS?|STATSSKULDV[AÄ]XEL|SSVX|BTF|BOT|LETRAS|BUBILL|DTB)\b/i],
  ['supranational', /\b(EIB|EUROPEAN INVESTMENT BANK|EUROPEAN UNION|EBRD|IBRD|WORLD BANK|INTL BK RECON|NORDIC INVESTMENT BANK|NIB|ASIAN DEVELOPMENT BANK|ADB|COUNCIL OF EUROPE|COE DEV|EUROFIMA|ESM|EFSF|INTER-AMERICAN DEV|IADB|AFRICAN DEV|IFC|INTL FINANCE CORP)\b/i],
  ['regional', /\b(PROVINCE OF|STATE OF|LAND [A-Z]+|BUNDESLAND|REGION|REGIONE|COMUNIDAD|REGIONEN|LANDSTING|CANTON)\b/i],
  ['municipal', /\b(CITY OF|MUNICIPALITY|KOMMUN|STAD|STADT|GEMEINDE|COMMUNE|VILLE DE|MUNI)\b/i],
  ['government', /\b(TREASURY|TREASURIES|UST|US TREAS|T-?NOTE|T-?BOND|GOVERNMENT|GOVT|GOVT BOND|REPUBLIC OF|KINGDOM OF|BUNDESREP|BUNDESREPUBLIK|BUND|BUNDS|BOBL|SCHATZ|OAT|OATS|BTP|BTPS|SGB|STATSOBLIGATION|SWEDISH GOVERNMENT|GILT|UKT|BONOS|SPGB|OLO|DSL|RAGB|NGB|RFGB|DGB|IRISH GOVT|JGB|CAN GOVT|ACGB)\b/i],
  ['covered', /\b(COVERED|S[AÄ]KERST[AÄ]LLD|PFANDBRIEF|PFANDBR|HYPOTEK|OBLIGATIONS? FONCI[EÈ]RES?|C[EÉ]DULAS|OMF|BOLIGKREDITT|REALKREDIT|MORTGAGE BANK|ASUNTOLUOTTOPANKKI)\b/i],
  ['subordinated', /\b(SUB|SUBORD|SUBORDINATED|T2|TIER 2|TIER2|AT1|TIER 1|LT2|JR|JUNIOR|EFTERST[AÄ]LLD|NACHRANG)\b/i],
  ['hybrid', /\b(HYBRID|HYB|COCO|CONTINGENT CONVERTIBLE)\b/i],
  ['convertible', /\b(CONV|CONVERTIBLE|CV|WANDEL|WANDELANLEIHE|KONVERTIBEL|OCEANE)\b/i],
  ['commercial_paper', /\b(CP|COMMERCIAL PAPER|F[OÖ]RETAGSCERTIFIKAT|NEU CP|ECP)\b/i],
  ['structured', /\b(CERTIFICATE|CERT|ZERTIFIKAT|STRUCTURED|EMTN LINKED|INDEX LINKED NOTE|AUTOCALL|BARRIER|EXPRESS|BONUS CERT|CREDIT LINKED|CLN)\b/i],
  ['securitised', /\b(ABS|MBS|RMBS|CMBS|CLO|CDO|CMO|SECURITI[SZ]ATION|ASSET[- ]BACKED|MORTGAGE[- ]BACKED)\b/i],
  ['bond', /\b(BOND|BONDS|NOTE|NOTES|OBLIGATION|OBL|ANLEIHE|ANL|SCHULDVERSCHREIBUNG|EMTN|MTN|DEBENTURE|SR UNSEC|SENIOR|SNR|PREFERRED SENIOR|NON-PREFERRED)\b/i],
  ['floating', /\b(FRN|FLOATING|FLOAT|FLOATER|VAR|VARIABLE|STIBOR|EURIBOR|SOFR|SONIA|NIBOR|CIBOR|ESTR|€STR|LIBOR|SARON)\b|\+\s*\d+(\.\d+)?\s*BPS?\b/i],
  ['inflation_linked', /\b(ILB|INFLATION|LINKER|REALOBLIGATION|OATI|OAT€I|BTP€I|TIPS|IL|INDEX-?LINKED|INFL)\b/i],
  ['perpetual', /\b(PERP|PERPETUAL|EVIGHET|UNDATED)\b/i],
  ['preferred', /\b(PREF|PREFS|PREFERRED|PREFERENCE|PREFERENS|PFD|VZ|VORZUG|PRF)\b/i],
  ['right', /\b(RIGHTS?|TECKNINGSR[AÄ]TT|TR|BEZUGSRECHT|DROITS?|BTA|INTERIMSAKTIE|SUBSCRIPTION RIGHT)\b/i],
  ['equity_class', /\b(SER(IE)?\.?\s*[AB]|CLASS [A-C]|ORD|ORDINARY|ADR|GDR|ADS|SDB|REG SHS|INHABER|NAMENS|AKTIE|AKTIEN|SHARES?|STOCK|COMMON|AG|AB|ASA|OYJ|PLC|INC|CORP|S\.?A\.?|N\.?V\.?|SE|SPA|LTD)\b|\s[A-D]$/i],
  ['real_estate', /\b(REAL ESTATE|FASTIGHET(ER|SFOND)?|IMMOBILIEN|IMMOBILIER|REIT|PROPERTY|PROPERTIES|SCPI|OPCI)\b/i],
  ['private_equity', /\b(PRIVATE EQUITY|BUYOUT|VENTURE)\b/i],
  ['infrastructure', /\b(INFRASTRUCTURE|INFRASTRUKTUR)\b/i],
  ['equity_fund', /\b(EQUITY|EQUITIES|AKTIE(FOND)?|AKTIEN(FONDS)?|ACTIONS|INDEX|MSCI|S&P|STOXX|OMX|FTSE|NASDAQ|SMALL CAP|SMÅBOLAG|GLOBAL EQ|WORLD)\b/i],
  ['debt_fund', /\b(BOND FUND|R[AÄ]NTEFOND|R[AÄ]NTA|OBLIGATIONSFOND|CREDIT|KREDIT|HIGH YIELD|HY|FIXED INCOME|RENTEN(FONDS)?|OBLIGATAIRE|AGGREGATE|CORPORATE BOND|GOVT BOND|TREASURY)\b/i],
  ['mixed_fund', /\b(MIXED|BALANCED|BLANDFOND|MISCHFONDS|ALLOCATION|MULTI[- ]ASSET|PATRIMOINE|DIVERSIFI[EÉ]|STRATEGY|STRATEGI)\b/i],
  ['alternative_fund', /\b(HEDGE|ALTERNATIVE|ABSOLUTE RETURN|LONG\/SHORT|MARKET NEUTRAL|MULTI-STRATEGY)\b/i],
];

/** Parse coupon text like "0.75", "3,5", "4 1/8", "4⅛". */
export function parseCouponText(s: string): number | undefined {
  const t = s.trim().replace(/⅛/, ' 1/8').replace(/¼/, ' 1/4').replace(/⅜/, ' 3/8').replace(/½/, ' 1/2').replace(/⅝/, ' 5/8').replace(/¾/, ' 3/4').replace(/⅞/, ' 7/8');
  const frac = /^(\d{1,2})?\s*(\d)\/(\d{1,2})$/.exec(t);
  if (frac) return (frac[1] ? Number(frac[1]) : 0) + Number(frac[2]) / Number(frac[3]);
  const n = /^\d{1,2}(?:[.,]\d{1,5})?$/.exec(t);
  if (n) return Number(t.replace(',', '.'));
  return undefined;
}

const y2 = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

interface DateHit {
  iso: string;
  text: string;
  index: number;
  confidence: Confidence;
  note?: string;
}

function findDates(name: string): DateHit[] {
  const hits: DateHit[] = [];
  const s = name.toUpperCase();
  let m: RegExpExecArray | null;
  // ISO: 2032-05-12
  const iso = /\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(s))) {
    const d = isoDate(+m[1], +m[2], +m[3]);
    if (d) hits.push({ iso: d, text: m[0], index: m.index, confidence: 'high' });
  }
  // Month name: 15-NOV-32, 15 NOV 2032, 15NOV2032
  const mon = /\b(\d{1,2})[-\s]?([A-Z]{3})[-\s]?(\d{4}|\d{2})\b/g;
  while ((m = mon.exec(s))) {
    const mm = MONTHS[m[2]];
    if (!mm) continue;
    const d = isoDate(y2(m[3]), mm, +m[1]);
    if (d) hits.push({ iso: d, text: m[0], index: m.index, confidence: 'high' });
  }
  // Numeric: dd/mm/yyyy, mm/dd/yy, dd.mm.yyyy
  const num = /\b(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})\b/g;
  while ((m = num.exec(s))) {
    if (hits.some((h) => h.index <= m!.index && m!.index < h.index + h.text.length)) continue;
    const a = +m[1];
    const b = +m[3];
    const y = y2(m[4]);
    if (a > 12) {
      const d = isoDate(y, b, a);
      if (d) hits.push({ iso: d, text: m[0], index: m.index, confidence: 'high' });
    } else if (b > 12) {
      const d = isoDate(y, a, b);
      if (d) hits.push({ iso: d, text: m[0], index: m.index, confidence: 'high' });
    } else if (a === b) {
      const d = isoDate(y, a, b);
      if (d) hits.push({ iso: d, text: m[0], index: m.index, confidence: 'high' });
    } else {
      // Ambiguous. Bloomberg-style "02/15/31" (2-digit year, slash) is month-first; European dd/mm/yyyy and dd.mm.yyyy are day-first.
      const monthFirst = m[2] === '/' && m[4].length === 2;
      const d = monthFirst ? isoDate(y, a, b) : isoDate(y, b, a);
      const alt = monthFirst ? isoDate(y, b, a) : isoDate(y, a, b);
      if (d)
        hits.push({
          iso: d,
          text: m[0],
          index: m.index,
          confidence: 'low',
          note: `Ambiguous day/month order in "${m[0]}": read as ${monthFirst ? 'month-first' : 'day-first'} (${d})${alt ? `; the alternative is ${alt}` : ''}.`,
        });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function parseSecurityName(name: string | undefined | null): ParsedName {
  const out: ParsedName = { hints: new Set(), evidence: [] };
  if (!name) return out;
  const s = name.replace(/\s+/g, ' ').trim();

  for (const [hint, re] of HINT_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      out.hints.add(hint);
      out.evidence.push(`"${m[0].trim()}" → ${hint.replace(/_/g, ' ')}`);
    }
  }

  // Sovereign naming: a country name followed by a coupon, date or year ("SWEDEN 0.75% 12/11/2029").
  const upper = s.toUpperCase();
  const country = COUNTRY_NAMES.find((c) => upper.startsWith(`${c} `) && /^\s*(\d|[A-Z]{2,4}\s+\d|GOVT|GOVERNMENT|TREASURY)/.test(upper.slice(c.length)));
  if (country && !out.hints.has('government')) {
    out.hints.add('government');
    out.evidence.push(`name starts with country "${country}" followed by bond terms → government`);
  }

  // Maturity: the last full date in the name.
  const dates = findDates(s);
  const last = dates[dates.length - 1];
  if (last) out.maturity = { value: last.iso, confidence: last.confidence, text: last.text, ...(last.note ? { note: last.note } : {}) };
  else if (out.hints.has('perpetual')) out.maturity = { value: '9999-12-31', confidence: 'medium', text: 'PERP', note: 'Perpetual: TPT uses 9999-12-31.' };
  else {
    const year = /\b(20[2-9]\d|21\d\d)\b(?!.*\b(20[2-9]\d|21\d\d)\b)/.exec(s);
    if (year && !/\d{4}-\d/.test(s.slice(year.index))) out.maturityYear = Number(year[1]);
  }

  // Coupon: "0.75%", "3,5 %", "4 1/8%".
  const pct = /(?:^|[\s+])((?:\d{1,2}\s)?\d\/\d{1,2}|\d{1,2}(?:[.,]\d{1,5})?)\s?%/.exec(s);
  if (pct) {
    const v = parseCouponText(pct[1]);
    if (v !== undefined && v < 30) out.coupon = { value: v, confidence: 'high', text: pct[0].trim() };
  }
  // Bloomberg style: "<TICKER> <coupon> <date>" e.g. "UST 4 1/8 15-NOV-32", "BUND 0 02/15/31".
  if (!out.coupon && last) {
    const before = s.slice(0, last.index).trim();
    const m = /(?:^|\s)((?:\d{1,2}\s)?\d\/\d{1,2}|\d{1,2}(?:[.,]\d{1,5})?)$/.exec(before);
    if (m && !/^\d{4}$/.test(m[1])) {
      const v = parseCouponText(m[1]);
      const tokensBefore = before.slice(0, before.length - m[0].length).trim();
      if (v !== undefined && v < 30 && /[A-Z]/i.test(tokensBefore)) {
        out.coupon = { value: v, confidence: 'medium', text: m[1], };
        out.evidence.push(`"${m[1]}" before the maturity date read as coupon`);
      }
    }
  }
  if (out.hints.has('floating') && out.coupon) {
    out.evidence.push('Floating-rate note: the number in the name is usually a margin, not the coupon');
    out.coupon = { ...out.coupon, confidence: 'low' };
  }
  if (out.coupon) out.evidence.push(`coupon ${out.coupon.value}% from "${out.coupon.text}"`);
  if (out.maturity) out.evidence.push(`maturity ${out.maturity.value} from "${out.maturity.text}"`);
  if (out.maturityYear) out.evidence.push(`year ${out.maturityYear} in name (no full maturity date)`);
  return out;
}
