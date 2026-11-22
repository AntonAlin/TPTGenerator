/**
 * Portfolio-level data (fund and share class identification, NAV, dates,
 * management company, custodian …). The form is generated from the spec:
 * every field in the template's portfolio sections, so a new TPT version
 * brings its new portfolio fields automatically.
 */
import { spec, maybeField } from '../spec/index.ts';
import type { SpecField } from '../spec/types.ts';
import type { KeyValueStore } from '../profiles/store.ts';
import { DEFAULT_CONVENTIONS, type Conventions } from '../derive/resolve.ts';
import { isValidIsin } from '../ingest/identifiers.ts';
import { derived, fromUser, missing, type Resolved } from '../derive/provenance.ts';
import type { PortfolioDerivations } from '../derive/resolve.ts';

/**
 * Fields that describe one share class (identification, currency, NAV, price, shares).
 * Design decision based on the field comments ("per share class", "Share Class currency").
 */
export const SHARE_CLASS_FIELD_IDS = ['1', '2', '3', '4', '5', '8', '8b'];

/** Portfolio-level fields outside the "Portfolio Characteristics" sections. */
const EXTRA_PORTFOLIO_IDS = ['140'];
/** Filled automatically at export time, not in the form. */
const AUTOMATIC_IDS = ['1000'];

export const PORTFOLIO_FIELDS: SpecField[] = spec.fields.filter(
  (f) => (/Portfolio Characteristics/i.test(f.section) || EXTRA_PORTFOLIO_IDS.includes(f.id)) && !f.mustBeEmpty && !AUTOMATIC_IDS.includes(f.id),
);

export const FUND_FIELDS = PORTFOLIO_FIELDS.filter((f) => !SHARE_CLASS_FIELD_IDS.includes(f.id));
export const CLASS_FIELDS = SHARE_CLASS_FIELD_IDS.map((id) => maybeField(id)).filter((f): f is SpecField => !!f);

export type ReportingLevel = 'fund' | 'share_class';

export interface ShareClass {
  values: Record<string, string>;
}

export interface PortfolioState {
  level: ReportingLevel;
  /** Fund-level field values by TPT field id (also used for class fields at fund level). */
  values: Record<string, string>;
  shareClasses: ShareClass[];
  /** Base currency of the fund (= field 4 at fund level). */
  baseCurrency?: string;
  conventions: Conventions;
  /** FX rates entered by the user, quotation ccy → base ccy. */
  fxUser: Record<string, number>;
}

export const emptyPortfolio = (): PortfolioState => ({
  level: 'fund',
  values: {},
  shareClasses: [{ values: {} }],
  conventions: structuredClone(DEFAULT_CONVENTIONS),
  fxUser: {},
});

/** Base currency: field 4 at fund level, the explicit base currency at share-class level. */
export function baseCurrencyOf(p: PortfolioState): string | undefined {
  return (p.level === 'fund' ? p.values['4'] : p.baseCurrency) || undefined;
}

/** Fund NAV in base currency: field 5 at fund level; at share-class level the sum of class NAVs converted to base. */
export function fundNav(p: PortfolioState, fx: (ccy: string) => number | undefined): { nav?: number; note?: string } {
  if (p.level === 'fund') {
    const n = Number(p.values['5']);
    return Number.isFinite(n) && p.values['5'] ? { nav: n } : {};
  }
  let total = 0;
  const missingFx: string[] = [];
  for (const c of p.shareClasses) {
    const n = Number(c.values['5']);
    if (!c.values['5'] || !Number.isFinite(n)) return { note: 'Enter the NAV of every share class.' };
    const ccy = c.values['4'] || baseCurrencyOf(p);
    const rate = ccy ? fx(ccy) : undefined;
    if (rate === undefined) missingFx.push(ccy ?? '?');
    else total += n * rate;
  }
  if (missingFx.length) return { note: `FX rate missing for share class currency ${missingFx.join(', ')}.` };
  return { nav: total, note: 'Sum of share class NAVs converted to the base currency.' };
}

/**
 * Value of a portfolio field: what the user entered, else a derivation
 * (identification type from a valid ISIN, reporting date, cash ratio, duration,
 * SCR delivery flag), else blank.
 */
export function resolvePortfolioField(
  id: string,
  entered: Record<string, string>,
  derivations: PortfolioDerivations | undefined,
  today = new Date().toISOString().slice(0, 10),
): Resolved {
  const v = entered[id];
  if (v !== undefined && v !== '') return fromUser(v, 'Entered in the fund form');
  switch (id) {
    case '2':
      return entered['1'] && isValidIsin(entered['1']) ? derived('1', 'Portfolio identifier is a valid ISIN → type 1', 'high') : missing();
    case '7':
      return derived(today, 'Date the file was produced', 'high');
    case '9':
      return derivations?.cashRatio ?? missing();
    case '10':
      return derivations?.modifiedDuration ?? missing();
    case '11':
      return derived('N', 'This tool does not compute SCR contributions (fields 97–105 are left blank)', 'high');
    // Share price and number of shares from the NAV and the other one (the field 8b comment notes
    // that NAV may differ from price × shares by rounding).
    case '8': {
      const nav = positive(entered['5']);
      const shares = positive(entered['8b']);
      return nav && shares ? derived(round6(nav / shares), `NAV (field 5) ÷ number of shares (field 8b)`, 'high') : missing();
    }
    case '8b': {
      const nav = positive(entered['5']);
      const price = positive(entered['8']);
      return nav && price ? derived(round6(nav / price), `NAV (field 5) ÷ share price (field 8)`, 'high') : missing();
    }
    default:
      return missing();
  }
}

const positive = (v: string | undefined) => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Fund profiles (reusable portfolio data), stored in the browser.
// ---------------------------------------------------------------------------

export interface FundProfile {
  name: string;
  state: PortfolioState;
  updatedAt: string;
}

export interface FundProfileExport {
  format: 'tpt-generator-fund-profiles';
  version: 1;
  exportedAt: string;
  profiles: FundProfile[];
}

const PREFIX = 'fund:';

export class FundProfileRepository {
  constructor(private store: KeyValueStore) {}

  async list(): Promise<FundProfile[]> {
    return (await this.store.entries<FundProfile>(PREFIX)).map(([, v]) => v).sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(name: string, state: PortfolioState): Promise<FundProfile> {
    // Dates and NAV change every period: keep identification and conventions, drop period values.
    const keep = structuredClone(state);
    for (const id of ['5', '6', '7', '8', '8b', '9', '10']) delete keep.values[id];
    for (const c of keep.shareClasses) for (const id of ['5', '8', '8b']) delete c.values[id];
    delete keep.conventions.valuationDate;
    keep.fxUser = {};
    const p: FundProfile = { name, state: keep, updatedAt: new Date().toISOString() };
    await this.store.set(PREFIX + name, p);
    return p;
  }

  async remove(name: string) {
    await this.store.delete(PREFIX + name);
  }

  async exportAll(): Promise<FundProfileExport> {
    return { format: 'tpt-generator-fund-profiles', version: 1, exportedAt: new Date().toISOString(), profiles: await this.list() };
  }

  async importAll(data: unknown): Promise<number> {
    const d = data as Partial<FundProfileExport>;
    if (d?.format !== 'tpt-generator-fund-profiles' || !Array.isArray(d.profiles)) throw new Error('Not a TPT Generator fund profile export.');
    let n = 0;
    for (const p of d.profiles) {
      if (!p || typeof p.name !== 'string' || typeof p.state !== 'object' || !p.state?.values) continue;
      await this.store.set(PREFIX + p.name, { ...p, state: { ...emptyPortfolio(), ...p.state } });
      n++;
    }
    return n;
  }
}
