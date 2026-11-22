/**
 * Field resolution: for every holding and attribute, take the value from
 *   1. the input file,
 *   2. a derivation (with method and confidence),
 *   3. otherwise leave it blank,
 * and record the source of every value.
 */
import { parseCic } from '../data/cic.ts';
import { normalizeNace } from '../data/nace.ts';
import { isCountry } from '../data/iso.ts';
import { economicZone } from '../data/regions.ts';
import { isValidIsin, isValidLei, looksLikeIsin } from '../ingest/identifiers.ts';
import { ATTRS, type AttrKey } from './attributes.ts';
import { ASSET_CLASSES, inferAssetClass, type AssetClass, type AssetClassResult } from './assetClass.ts';
import { predictRow } from './rowModel.ts';
import { normalizeHeader } from '../detect/headerMatch.ts';
import { deriveCic, quotationZoneFromCic, underlyingCategoryFromCic } from './cicDerive.ts';
import { bondAnalytics, type BondAnalytics, type DayCount, type Frequency } from './fixedIncome.ts';
import type { FileValues, Holding } from './holdings.ts';
import { ROLE_LABEL, type AmountRole } from './amounts.ts';
import {
  derived,
  fromFile,
  hasValue,
  minConfidence,
  missing,
  type Confidence,
  type Resolved,
  type Scalar,
} from './provenance.ts';
import { detectCleanDirty, type FxEntry, type MvConvention } from './valuation.ts';

export interface Conventions {
  valuationDate?: string;
  portfolioCurrency?: string;
  /** Whether market values in the file include accrued interest. */
  mvConvention: MvConvention;
  dayCount: DayCount;
  /** Coupon frequency assumed for analytics when the file does not give it, by currency ("*" = default). */
  frequencyByCurrency: Record<string, Frequency>;
  /** Estimate issuer country from the ISIN prefix when nothing better is available (flagged as estimated). */
  issuerCountryFromIsin: boolean;
}

export const DEFAULT_CONVENTIONS: Conventions = {
  mvConvention: 'auto',
  dayCount: 'ACT/ACT ICMA',
  frequencyByCurrency: { '*': 1, USD: 2, GBP: 2, CAD: 2, AUD: 2, JPY: 2 },
  issuerCountryFromIsin: true,
};

export interface ResolveContext extends Conventions {
  fx: Record<string, FxEntry>;
  /** Net asset value in portfolio currency entered by the user. */
  nav?: number;
  /** Asset-type texts the user gave a class to (by typeTextKey), from this file or earlier ones. */
  typeLessons?: Map<string, { cls: AssetClass; source?: string }>;
  /** Use the row asset-class model where the rules are unsure (default true). */
  rowModel?: boolean;
}

/** How an asset-type text is looked up in the lessons: case, accents and punctuation do not matter. */
export const typeTextKey = (t: string) => normalizeHeader(t);

export interface ResolvedHolding {
  holding: Holding;
  assetClass: AssetClassResult;
  effectiveClass: AssetClass;
  cicAlternatives: string[];
  attrs: Record<AttrKey, Resolved>;
  analytics?: BondAnalytics;
  issues: string[];
}

export interface PortfolioDerivations {
  nav: Resolved<number>;
  cashRatio: Resolved<number>;
  modifiedDuration: Resolved<number>;
}

export interface ResolveResult {
  rows: ResolvedHolding[];
  portfolio: PortfolioDerivations;
}

/** Map a known CIC back to an asset class (exact category+sub match, else the category's first class). */
export function cicToAssetClass(cic: string): AssetClass | undefined {
  const cat = cic[2];
  const sub = cic[3];
  const entries = Object.entries(ASSET_CLASSES) as [AssetClass, (typeof ASSET_CLASSES)[AssetClass]][];
  return (entries.find(([, i]) => i.cic[0] === cat && i.cic[1] === sub) ?? entries.find(([, i]) => i.cic[0] === cat))?.[0];
}

const round = (x: number, d = 10) => Math.round(x * 10 ** d) / 10 ** d;

export function resolveHoldings(holdings: Holding[], ctx: ResolveContext): ResolveResult {
  const rows = holdings.map((h) => resolveOne(h, ctx));

  // NAV: user entry, else the sum of all holdings (incl. accrued) — flagged as derived.
  let nav: Resolved<number>;
  if (ctx.nav && ctx.nav > 0) nav = { value: ctx.nav, source: 'user', method: 'Entered in the fund form', confidence: 'high' };
  else {
    const vals = rows.map((r) => r.attrs.mv_port_dirty.value);
    const known = vals.filter((v): v is number => typeof v === 'number');
    nav = known.length
      ? derived(
          round(known.reduce((a, b) => a + b, 0), 2),
          'Sum of market values incl. accrued interest of all holdings',
          known.length === vals.length ? 'medium' : 'low',
          'Enter the official NAV in the fund form; the sum of holdings ignores liabilities and receivables not in the file.' +
            (known.length < vals.length ? ` ${vals.length - known.length} holding(s) have no value and are not included.` : ''),
        )
      : missing('No NAV entered and no market values available.');
  }

  // Weights (field 26): file value, else value / NAV.
  for (const r of rows) {
    const fileW = r.holding.file.weight;
    if (fileW !== undefined) r.attrs.weight = fromFile(round(fileW), 'Input file (scaled to 1 = 100%)');
    else if (typeof r.attrs.mv_port_dirty.value === 'number' && typeof nav.value === 'number' && nav.value !== 0) {
      r.attrs.weight = derived(
        round(r.attrs.mv_port_dirty.value / nav.value),
        `Market value incl. accrued (portfolio ccy) ÷ NAV (${nav.source === 'user' ? 'entered' : 'sum of holdings'})`,
        minConfidence(r.attrs.mv_port_dirty.confidence, nav.source === 'user' ? 'high' : 'medium'),
      );
    } else r.attrs.weight = missing('No market value or NAV.');
  }

  // Portfolio-level derivations (fields 9 and 10).
  let cash = 0;
  let cashKnown = false;
  let dur = 0;
  let durWeight = 0;
  for (const r of rows) {
    const w = r.attrs.weight.value;
    const cic = r.attrs.cic.value;
    if (typeof w !== 'number') continue;
    if (typeof cic === 'string' && ['71', '72', '73'].includes(cic.slice(2))) {
      cash += w;
      cashKnown = true;
    }
    if (typeof r.attrs.modified_duration.value === 'number') {
      dur += w * r.attrs.modified_duration.value;
      durWeight += w;
    }
  }
  const cashRatio = derived(
    round(cash),
    'Sum of weights of holdings with CIC xx71, xx72, xx73 (cash and short-term deposits; xx74 excluded per field 9 comment)',
    cashKnown ? 'medium' : 'low',
    cashKnown ? undefined : 'No cash holdings identified.',
  );
  const modifiedDuration =
    durWeight > 0
      ? derived(
          round(dur, 6),
          'Σ weight × modified duration over holdings with a computed duration (others count as 0)',
          'low',
          `Durations computed for holdings worth ${(durWeight * 100).toFixed(1)}% of NAV; floating-rate notes, funds and derivatives without data count as 0.`,
        )
      : missing('No holding has a modified duration.');

  return { rows, portfolio: { nav, cashRatio, modifiedDuration } };
}

function resolveOne(h: Holding, ctx: ResolveContext): ResolvedHolding {
  const f = h.file;
  const issues: string[] = [];
  const attrs = Object.fromEntries(ATTRS.map((a) => [a.key, missing()])) as unknown as Record<AttrKey, Resolved>;

  // ISIN-shaped values with a bad check digit are errors; other codes in the ISIN column (e.g. "FWD-0001"
  // for an OTC derivative) are treated as non-ISIN identifiers.
  const isinShaped = !!f.isin && looksLikeIsin(f.isin);
  const isin = isinShaped && isValidIsin(f.isin) ? f.isin : undefined;
  if (isinShaped && !isin) issues.push(`"${f.isin}" is not a valid ISIN (check digit fails).`);
  /** file → derived → blank. */
  const pick = (fileVal: Resolved | undefined, derivedVal?: Resolved): Resolved => {
    if (hasValue(fileVal)) return fileVal;
    if (hasValue(derivedVal)) return derivedVal;
    return derivedVal ?? missing();
  };
  const file = <T extends Scalar>(v: T | undefined, method?: string) => (v === undefined ? undefined : fromFile(v, method));
  /** File value of an amount, with how its cell was interpreted when that was decided cell by cell. */
  const amountFromFile = (role: AmountRole, value: number): Resolved<number> => {
    const ci = h.amounts?.cells.find((c) => c.role === role);
    const scaledNote = ci?.cell.scaled ? `${ci.cell.scaled}.` : undefined;
    if (!ci || !ci.moved) return { ...fromFile(value), ...(scaledNote ? { note: scaledNote } : {}) };
    const a = h.amounts!;
    const alt = a.runnerUp && a.confidence !== 'high' ? `Alternative reading (${Math.round(a.runnerUp.probability * 100)}%): ${a.runnerUp.description}.` : undefined;
    const note = [scaledNote, alt].filter(Boolean).join(' ');
    return {
      value,
      source: 'file',
      method: `Input file, column "${ci.cell.header}" read as ${ROLE_LABEL[role]}: ${a.evidence[0]}`,
      confidence: a.confidence,
      ...(note ? { note } : {}),
    };
  };

  // --- Identification -------------------------------------------------------
  attrs.identifier = pick(f.isin ? fromFile(f.isin) : f.other_identifier ? fromFile(f.other_identifier) : undefined, missing('No identifier in the file.'));
  attrs.id_type = pick(
    undefined,
    isin && attrs.identifier.value === f.isin
      ? derived('1', 'Valid ISIN → type 1 (ISO 6166)', 'high')
      : missing(f.other_identifier || (f.isin && !isinShaped) ? 'Identifier is not an ISIN: its identification type is unknown.' : undefined),
  );
  attrs.name = f.security_name ? fromFile(f.security_name) : missing();

  // --- Asset class & CIC ----------------------------------------------------
  const fileCic = f.cic && parseCic(f.cic).valid ? f.cic : undefined;
  if (f.cic && !fileCic) issues.push(`CIC "${f.cic}" in the file is not valid: ${parseCic(f.cic).errors.join(' ')}`);
  const ac = inferAssetClass({
    rowModel: ctx.rowModel === false ? undefined : predictRow(f, ctx.valuationDate),
    taughtType: f.asset_type ? ctx.typeLessons?.get(typeTextKey(f.asset_type)) : undefined,
    name: f.security_name,
    assetTypeText: f.asset_type,
    section: h.section,
    isin: f.isin,
    hasCoupon: f.coupon !== undefined,
    hasMaturity: f.maturity_date !== undefined,
    price: f.price,
    unitPriced:
      f.quantity !== undefined &&
      f.price !== undefined &&
      f.market_value_local !== undefined &&
      f.market_value_local !== 0 &&
      Math.abs(f.quantity * f.price - f.market_value_local) <= Math.max(1, Math.abs(f.market_value_local) * 0.005),
    maturity: f.maturity_date,
    valuationDate: ctx.valuationDate,
  });
  const derivedCic = deriveCic({ assetClass: ac.assetClass, assetClassConfidence: ac.confidence, isEtf: ac.isEtf, isin: f.isin, fileCountry: f.country, derivativeSub: ac.derivativeSub });
  attrs.cic = pick(file(fileCic), derivedCic.cic);
  const finalCic = typeof attrs.cic.value === 'string' ? attrs.cic.value : undefined;
  const effectiveClass = (finalCic && fileCic ? cicToAssetClass(finalCic) : undefined) ?? ac.assetClass;
  const info = ASSET_CLASSES[effectiveClass];
  attrs.asset_class = derived(info.label, ac.evidence.join('; '), effectiveClass === ac.assetClass ? ac.confidence : 'high');
  attrs.quotation_zone = quotationZoneFromCic(finalCic) ?? missing('No CIC.');
  attrs.underlying_category = underlyingCategoryFromCic(finalCic) ?? missing('No CIC.');
  const isFI = !!info.isFixedIncome || ['deposit_short', 'deposit_long'].includes(effectiveClass);
  const hints = ac.parsedName.hints;
  const floating = hints.has('floating');

  // --- Currency ---------------------------------------------------------------
  const ccyFromName = !f.currency && effectiveClass === 'cash' ? f.security_name?.match(/\b[A-Z]{3}\b/)?.[0] : undefined;
  attrs.currency = f.currency
    ? fromFile(f.currency)
    : ccyFromName
      ? derived(ccyFromName, `Currency code in the name "${f.security_name}"`, 'medium')
      : missing('No currency in the file.');
  const ccy = typeof attrs.currency.value === 'string' ? attrs.currency.value : undefined;

  // --- Interest rate characteristics ----------------------------------------
  const pn = ac.parsedName;
  attrs.coupon = pick(
    file(f.coupon),
    isFI && pn.coupon && !floating ? derived(pn.coupon.value, `Parsed from name ("${pn.coupon.text}")`, pn.coupon.confidence) : floating && isFI ? missing('Floating-rate note: current coupon (last fixing + margin) is not in the file.') : undefined,
  );
  attrs.maturity = pick(
    file(f.maturity_date),
    pn.maturity && (isFI || effectiveClass === 'future' || effectiveClass === 'forward')
      ? derived(pn.maturity.value, `Parsed from name ("${pn.maturity.text}")`, pn.maturity.confidence, pn.maturity.note)
      : pn.maturityYear && isFI
        ? missing(`Name only gives the year ${pn.maturityYear}; enter the exact maturity date.`)
        : undefined,
  );
  if (f.maturity_date && pn.maturity && pn.maturity.value !== f.maturity_date && pn.maturity.confidence !== 'low') {
    issues.push(`Maturity in the file (${f.maturity_date}) differs from the name (${pn.maturity.value}).`);
  }
  if (f.coupon !== undefined && pn.coupon && Math.abs(pn.coupon.value - f.coupon) > 1e-6 && !floating) {
    issues.push(`Coupon in the file (${f.coupon}) differs from the name (${pn.coupon.value}).`);
  }
  attrs.interest_rate_type = pick(
    file(rateTypeOf(f.interest_rate_type)),
    !isFI
      ? undefined
      : floating
        ? derived('Floating', 'Floating-rate keyword in the name', 'medium')
        : hints.has('inflation_linked')
          ? derived('Inflation_linked', 'Inflation-linked keyword in the name', 'medium')
          : hasValue(attrs.coupon)
            ? derived('Fixed', 'Has a coupon and no floating/inflation keyword', attrs.coupon.confidence === 'high' ? 'medium' : 'low')
            : undefined,
  );
  attrs.coupon_frequency = pick(file(f.coupon_frequency !== undefined ? String(f.coupon_frequency) : undefined));
  for (const k of ['redemption_type', 'redemption_rate', 'callable', 'securitisation', 'guarantee'] as AttrKey[]) {
    attrs[k] = pick(undefined);
  }
  attrs.call_date = pick(file(f.call_date));
  const cqs = f.cqs !== undefined && Number.isInteger(f.cqs) && f.cqs >= 0 && f.cqs <= 6 ? String(f.cqs) : undefined;
  if (f.cqs !== undefined && cqs === undefined) issues.push(`Credit quality step "${f.cqs}" is not 0–6.`);
  attrs.cqs = pick(file(cqs));
  attrs.rating_agency = pick(file(agencyOf(f.rating_agency)));
  attrs.interest_margin = pick(floating ? file(f.spread) : undefined);

  // --- Derivative terms (file only: nothing here is derivable without market data) ---------
  attrs.contract_size = pick(file(f.contract_size));
  attrs.strike = pick(file(f.strike));
  attrs.call_put = pick(
    file(callPutOf(f.call_put)),
    effectiveClass === 'call_option' ? derived('Cal', 'Classified as a call option', ac.confidence) : effectiveClass === 'put_option' ? derived('Put', 'Classified as a put option', ac.confidence) : undefined,
  );
  attrs.exercise_type = pick(file(exerciseOf(f.exercise_type)));
  attrs.underlying_name = pick(file(f.underlying_name));
  attrs.underlying_id = pick(file(f.underlying_id));
  attrs.underlying_id_type = pick(undefined, f.underlying_id && isValidIsin(f.underlying_id) ? derived('1', 'Underlying identifier is a valid ISIN → type 1', 'high') : undefined);
  attrs.underlying_price = pick(file(f.underlying_price));
  attrs.delta = pick(file(f.delta));
  attrs.covered = pick(undefined, ['covered_bond', 'gov_covered_bond'].includes(effectiveClass) ? derived('C', 'Classified as a covered bond', 'medium') : undefined);
  attrs.subordinated = pick(
    undefined,
    ['subordinated_bond', 'hybrid_bond'].includes(effectiveClass) ? derived('Y', 'Subordinated/hybrid keyword in the name', 'medium') : undefined,
  );
  attrs.credit_rating = pick(file(f.rating));

  // --- Valuation --------------------------------------------------------------
  const fxEntry = ccy ? (ccy === ctx.portfolioCurrency ? { rate: 1, source: 'identity' as const } : ctx.fx[ccy]) : undefined;
  const fx = fxEntry?.rate;
  attrs.fx_rate = fx !== undefined ? derived(fx, fxEntry!.source === 'user' ? 'FX rate entered by user' : fxEntry!.source === 'identity' ? 'Portfolio currency' : 'Implied from local and portfolio values in the file', fxEntry!.source === 'implied' ? 'medium' : 'high') : missing(ccy ? `No FX rate for ${ccy}: enter it in the fund step.` : 'No currency.');
  attrs.price = file(f.price) ?? missing();

  const notionalBased = ['forward', 'swap', 'credit_derivative'].includes(effectiveClass);
  attrs.nominal = f.nominal !== undefined
    ? amountFromFile('nominal', f.nominal)
    : (isFI || notionalBased) && f.quantity !== undefined
      ? derived(f.quantity, notionalBased ? 'Quantity column used as the contract (notional) amount for this forward/swap/CDS' : 'Quantity column used as nominal amount for this debt instrument', 'medium')
      : info.cic[0] === '7' && f.market_value_local !== undefined
        ? // A cash balance read as the account's value: for cash the balance is also the nominal.
          derived(f.market_value_local, 'Cash: the balance is the nominal amount (TPT field 19 for CIC 7)', 'high')
        : missing();
  attrs.quantity =
    f.quantity !== undefined && !((isFI || notionalBased) && f.nominal === undefined)
      ? amountFromFile('quantity', f.quantity)
      : missing(isFI ? 'Debt instrument: quantity reported as nominal (field 19).' : notionalBased ? 'Forward/swap/CDS: amount reported as nominal (field 19).' : undefined);
  const nominal = typeof attrs.nominal.value === 'number' ? attrs.nominal.value : undefined;

  // Bond analytics (accrued, yield, duration) — fixed coupon bonds only.
  const coupon = typeof attrs.coupon.value === 'number' ? attrs.coupon.value : undefined;
  const maturity = typeof attrs.maturity.value === 'string' ? attrs.maturity.value : undefined;
  const freqKnown = attrs.coupon_frequency.value !== undefined ? Number(attrs.coupon_frequency.value) : undefined;
  const frequency = ([1, 2, 4, 12].includes(freqKnown ?? 0) ? freqKnown : ctx.frequencyByCurrency[ccy ?? ''] ?? ctx.frequencyByCurrency['*'] ?? 1) as Frequency;
  let analytics: BondAnalytics | undefined;
  const fixedRate = attrs.interest_rate_type.value === 'Fixed' || (attrs.interest_rate_type.value === undefined && coupon !== undefined && !floating);
  if (info.isFixedIncome && fixedRate && coupon !== undefined && maturity && ctx.valuationDate) {
    analytics = bondAnalytics({ coupon, maturity, settlement: ctx.valuationDate, cleanPrice: f.price, frequency, dayCount: ctx.dayCount });
  }
  const inputConf = minConfidence(attrs.coupon.confidence, attrs.maturity.confidence, freqKnown ? 'high' : 'medium');
  const freqNote = freqKnown ? '' : ` Coupon frequency ${frequency}/year is an assumption (change it in step 3).`;

  let accrued: Resolved<number>;
  if (f.accrued_interest === undefined && f.dirty_price !== undefined && f.price !== undefined && isFI && nominal !== undefined) {
    accrued = derived(round(((f.dirty_price - f.price) * nominal) / 100, 2), 'Dirty price − clean price, × nominal ÷ 100', 'high');
  } else if (f.accrued_interest !== undefined) {
    accrued = fromFile(f.accrued_interest, 'Input file (assumed quotation currency)');
    if (h.scaled?.accrued_interest) accrued.note = `${h.scaled.accrued_interest}.`;
  }
  else if (analytics && nominal !== undefined) {
    accrued = derived(round((analytics.accruedPer100 * nominal) / 100, 2), `Computed: ${analytics.assumptions}`, inputConf, freqNote.trim() || undefined);
  } else if (!isFI) accrued = derived(0, `No accrued interest for ${info.label.toLowerCase()}`, 'high');
  else accrued = missing(floating ? 'Floating-rate note: accrued interest needs the current fixing.' : 'Coupon, maturity, nominal or valuation date missing: accrued interest not computed.');
  attrs.accrued_local = accrued;
  const ai = accrued.value;

  // Market value in local currency as given/derived (convention not yet applied).
  const isDerivativeCic = /^[A-F]$/.test(String(attrs.cic.value ?? '').charAt(2)) || /^[A-F]$/.test(info.cic[0]);
  let mvLocal: Resolved<number> | undefined;
  let computedClean = false;
  if (f.market_value_local !== undefined) mvLocal = amountFromFile('mv_local', f.market_value_local);
  else if (f.market_value_portfolio !== undefined && fx) {
    mvLocal = derived(round(f.market_value_portfolio / fx, 2), `Portfolio-currency value ÷ FX rate ${fx}`, fxEntry?.source === 'implied' ? 'medium' : 'high');
  } else if (f.price !== undefined && isFI && nominal !== undefined) {
    mvLocal = derived(round((nominal * f.price) / 100, 2), 'Nominal × clean price ÷ 100', 'medium');
    computedClean = true;
  } else if (f.price !== undefined && f.quantity !== undefined && !isDerivativeCic) {
    // Not for derivatives: contracts × price is the underlying's value, not the contract's
    // (a future is worth about zero after daily margining; an option's price is its premium).
    mvLocal = derived(round(f.quantity * f.price, 2), 'Quantity × price', 'medium');
    computedClean = true;
  } else if (info.cic[0] === '7' && (nominal ?? f.quantity) !== undefined) {
    // A cash balance is its own market value.
    mvLocal = derived(round((nominal ?? f.quantity)!, 2), 'Cash: the balance is the market value', 'high');
  }

  // Derivatives the file does not value. A future is margined daily: what it gained or lost is paid
  // as variation margin, so after settlement it is worth 0 (the template's own comment on fields 22
  // and 24). A forward or swap is valued as the difference of its two legs' notionals at today's
  // FX rates: undiscounted and without forward points, so an estimate, marked as one.
  let mvPortDerived: Resolved<number> | undefined;
  if (!mvLocal && f.market_value_portfolio === undefined) {
    if (effectiveClass === 'future') {
      const why = 'Future: margined daily, so after the variation margin is paid its market value is 0 (TPT fields 22 and 24: market values of listed derivatives with daily margin calls should be close to zero)';
      mvLocal = derived(0, why, 'high');
      mvPortDerived = derived(0, why, 'high');
    } else if (effectiveClass === 'forward' || effectiveClass === 'swap') {
      const v = valueFromLegs(f, ccy, effectiveClass === 'swap', (c) => (c === ctx.portfolioCurrency ? 1 : ctx.fx[c]?.rate), ctx.portfolioCurrency);
      if (v.value !== undefined) {
        mvPortDerived = derived(v.value, v.method, 'low', LEG_NOTE);
        if (fx) mvLocal = derived(round(v.value / fx, 2), `${v.method}; ÷ FX rate ${fx} for ${ccy}`, 'low', LEG_NOTE);
      } else if (v.missing) issues.push(v.missing);
    }
  }

  // Clean or dirty?
  let conv: 'clean' | 'dirty' = ctx.mvConvention === 'dirty' ? 'dirty' : 'clean';
  let convNote = '';
  if (computedClean) conv = 'clean';
  else if (ctx.mvConvention === 'auto' && isFI && mvLocal?.value !== undefined && nominal !== undefined && f.price !== undefined && ai !== undefined) {
    const d = detectCleanDirty(mvLocal.value, nominal, f.price, ai);
    if (d) {
      conv = d;
      convNote = `File value matches nominal × price ${d === 'clean' ? 'without' : 'plus'} accrued interest → treated as ${d}.`;
    } else convNote = 'Could not tell whether the file value includes accrued interest; assumed clean.';
  } else if (ctx.mvConvention === 'auto' && isFI) convNote = 'Assumed the file value excludes accrued interest (clean).';

  const splitValue = (base: Resolved<number> | undefined, factor: number, label: string): [Resolved, Resolved] => {
    if (!base || base.value === undefined) return [missing(`No ${label} market value.`), missing(`No ${label} market value.`)];
    const v = base.value;
    const aiConv = ai !== undefined ? ai * factor : undefined;
    const keep = (value: number, extra?: string): Resolved => ({ ...base, value: round(value, 2), ...(extra ? { note: [base.note, extra].filter(Boolean).join(' ') } : {}) });
    if (aiConv === undefined) {
      const other = derived(round(v, 2), `Same as the ${conv} value: accrued interest unknown`, 'low', 'Accrued interest is unknown; clean and dirty values are reported as equal.');
      return conv === 'clean' ? [other, keep(v, convNote)] : [keep(v, convNote), other];
    }
    if (aiConv === 0) return [keep(v), keep(v)];
    const conf = minConfidence(base.confidence, accrued.confidence);
    if (conv === 'clean') return [derived(round(v + aiConv, 2), `${base.source === 'file' ? 'File' : 'Derived'} clean value + accrued interest`, conf, convNote || undefined), keep(v, convNote)];
    return [keep(v, convNote), derived(round(v - aiConv, 2), `${base.source === 'file' ? 'File' : 'Derived'} dirty value − accrued interest`, conf, convNote || undefined)];
  };
  [attrs.mv_local_dirty, attrs.mv_local_clean] = splitValue(mvLocal, 1, 'local');

  let mvPort: Resolved<number> | undefined;
  if (f.market_value_portfolio !== undefined) mvPort = amountFromFile('mv_port', f.market_value_portfolio);
  else if (mvPortDerived) mvPort = mvPortDerived;
  else if (mvLocal?.value !== undefined && fx) {
    mvPort = derived(round(mvLocal.value * fx, 2), `Local value × FX rate ${fx} (${fxEntry!.source})`, minConfidence(mvLocal.confidence, fxEntry!.source === 'implied' ? 'medium' : 'high'));
  }
  [attrs.mv_port_dirty, attrs.mv_port_clean] = splitValue(mvPort, fx ?? 1, 'portfolio-currency');
  if (!mvPort && mvLocal && !fx && mvLocal.value !== 0) {
    attrs.mv_port_dirty = missing(`No FX rate for ${ccy}.`);
    attrs.mv_port_clean = missing(`No FX rate for ${ccy}.`);
  }

  if (f.modified_duration !== undefined || f.yield !== undefined) {
    // The file's own analytics come first; what it lacks is computed below where possible.
    if (f.modified_duration !== undefined) attrs.modified_duration = fromFile(f.modified_duration);
    if (f.yield !== undefined) attrs.valuation_yield = fromFile(f.yield, 'Input file (in %)');
  }
  if (analytics?.modifiedDuration !== undefined) {
    if (f.modified_duration === undefined) attrs.modified_duration = derived(round(analytics.modifiedDuration, 6), `Computed from coupon, maturity and clean price: ${analytics.assumptions}`, minConfidence(inputConf, 'medium'), freqNote.trim() || undefined);
    if (f.yield === undefined) attrs.valuation_yield = derived(
      round(analytics.yieldToMaturity! * 100, 6),
      `Yield to maturity solved from the clean price + accrued: ${analytics.assumptions}`,
      minConfidence(inputConf, 'medium'),
      `Expressed in percent like the coupon (e.g. 2.5 = 2.5%).${freqNote}`,
    );
  } else if (info.isFixedIncome) {
    const why = floating
      ? 'Floating-rate note: duration and yield need index curves (not available).'
      : !ctx.valuationDate
        ? 'Enter the valuation date to compute duration and yield.'
        : 'Needs coupon, maturity and clean price.';
    if (f.modified_duration === undefined) attrs.modified_duration = missing(why);
    if (f.yield === undefined) attrs.valuation_yield = missing(why);
  }

  // --- Issuer ------------------------------------------------------------------
  attrs.issuer_name = pick(file(f.issuer_name));
  const lei = f.issuer_lei && isValidLei(f.issuer_lei) ? f.issuer_lei : undefined;
  if (f.issuer_lei && !lei) issues.push(`Issuer LEI "${f.issuer_lei}" fails the ISO 17442 check.`);
  attrs.issuer_id = pick(lei ? fromFile(lei, 'Issuer LEI from the file') : undefined);
  const idVal = typeof attrs.issuer_id.value === 'string' ? attrs.issuer_id.value : undefined;
  attrs.issuer_id_type = pick(undefined, idVal && isValidLei(idVal) ? derived('1', 'Issuer id is a valid LEI → type 1', 'high') : undefined);
  attrs.group_name = pick(file(f.group_name));
  const groupLei = f.group_lei && isValidLei(f.group_lei) ? f.group_lei : undefined;
  if (f.group_lei && !groupLei) issues.push(`Group LEI "${f.group_lei}" fails the ISO 17442 check.`);
  attrs.group_id = pick(groupLei ? fromFile(groupLei, 'Group LEI from the file') : undefined);
  attrs.group_id_type = pick(undefined, groupLei ? derived('1', 'Group id is a valid LEI → type 1', 'high') : undefined);
  // NACE only from the file, reformatted to the TPT format; never guessed from names.
  const naceCode = f.nace ? normalizeNace(f.nace) : undefined;
  if (f.nace && !naceCode) issues.push(`"${f.nace}" is not a NACE Rev. 2 code.`);
  attrs.nace = pick(naceCode ? fromFile(naceCode, naceCode === f.nace ? 'Input file' : `Input file ("${f.nace}" written as a TPT NACE code)`) : undefined);

  const isinCountry = f.isin?.slice(0, 2);
  let countryDerived: Resolved | undefined;
  if (effectiveClass === 'supranational_bond') countryDerived = derived('XA', 'Supranational issuer → XA (allowed by field 52)', 'medium');
  else if (['gov_bond', 'treasury_bill', 'gov_covered_bond'].includes(effectiveClass) && isinCountry && isCountry(isinCountry)) {
    countryDerived = derived(isinCountry, `Government bond: issuer country taken from the ISIN prefix ${isinCountry}`, 'medium', 'Estimated.');
  } else if (ctx.issuerCountryFromIsin && isinCountry && isCountry(isinCountry) && !['cash', 'deposit_short', 'deposit_long'].includes(effectiveClass)) {
    countryDerived = derived(isinCountry, `ISIN prefix ${isinCountry}`, 'low', 'Estimated: the ISIN prefix is not always the issuer country (e.g. depositary receipts, foreign-registered issues).');
  }
  attrs.issuer_country = pick(
    f.country && isCountry(f.country) ? fromFile(f.country, 'Country column in the file (assumed to be the issuer country)') : undefined,
    countryDerived ?? missing(effectiveClass === 'cash' ? 'Cash: the issuer is the depositary bank, whose country is not in the file.' : undefined),
  );
  const zone = economicZone(typeof attrs.issuer_country.value === 'string' ? attrs.issuer_country.value : undefined);
  attrs.issuer_area = zone ? derived(zone, `Issuer country ${attrs.issuer_country.value} → economic area ${zone}`, minConfidence(attrs.issuer_country.confidence, 'high')) : missing();

  return { holding: h, assetClass: ac, effectiveClass, cicAlternatives: derivedCic.alternatives, attrs, analytics, issues };
}

/** Confidence label helper for UIs. */
export const confidenceOf = (r: Resolved): Confidence | undefined => r.confidence;

/** Interest rate type as written ("fast", "rörlig", "fixe", "FRN") → the TPT code (field 32). */
export function rateTypeOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (/^(fixed|fix|fixe|fast|fest|festverzinslich|fixed rate|taux fixe)$/.test(t)) return 'Fixed';
  if (/^(floating|float|frn|rörlig|variabel verzinslich|floating rate|taux variable|flottant)$/.test(t)) return 'Floating';
  if (/^(variable|variabel|var)$/.test(t)) return 'Variable';
  if (/inflation|real|index-?linked|realränte/.test(t)) return 'Inflation_linked';
  return undefined;
}
/** Option type as written ("C", "köp", "Put") → "Cal" / "Put" (field 60). */
export function callPutOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (/^(c|call|cal|köp|köpoption|kaufoption|achat)$/.test(t)) return 'Cal';
  if (/^(p|put|sälj|säljoption|verkaufsoption|vente)$/.test(t)) return 'Put';
  if (/^cap$/.test(t)) return 'Cap';
  if (/^(floor|flr)$/.test(t)) return 'Flr';
  return undefined;
}
/** Exercise style as written → "AM" / "EU" / "AS" / "BE" (field 64). */
export function exerciseOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (/^(am|american|amerikansk|amerikanisch|américaine|americaine)$/.test(t)) return 'AM';
  if (/^(eu|european|europeisk|europäisch|européenne|europeenne)$/.test(t)) return 'EU';
  if (/^(as|asian|asiatisk|asiatisch|asiatique)$/.test(t)) return 'AS';
  if (/^(be|bermudan|bermuda)$/.test(t)) return 'BE';
  return undefined;
}
/** Rating agency name as written → a consistent name (field 113). */
export function agencyOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (/^(s ?& ?p|sp|standard ?& ?poor'?s)/.test(t)) return 'S&P';
  if (/^moody/.test(t)) return "Moody's";
  if (/^fitch/.test(t)) return 'Fitch';
  return v.trim();
}


const LEG_NOTE =
  "An estimate: the legs' notionals at today's FX rates, undiscounted, without forward points or accrued swap interest. Use the counterparty's or your valuation system's market value when you have it.";

const fmtAmount = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * A forward's or swap's value in portfolio currency as received leg − paid leg, each at its FX rate.
 * Leg 1 is the side bought or received and leg 2 the side sold or paid, unless the signs say the
 * opposite (leg 1 negative, leg 2 positive). A swap's legs without a currency are in the row's
 * currency; a forward needs both currencies, or one of them and a row currency that differs from it.
 */
export function valueFromLegs(
  f: Pick<FileValues, 'leg1_amount' | 'leg1_currency' | 'leg2_amount' | 'leg2_currency'>,
  rowCcy: string | undefined,
  isSwap: boolean,
  rate: (ccy: string) => number | undefined,
  portfolioCcy?: string,
): { value?: number; method: string; missing?: string } {
  const a1 = f.leg1_amount;
  const a2 = f.leg2_amount;
  if (a1 === undefined && a2 === undefined) return { method: '' };
  if (a1 === undefined || a2 === undefined) return { method: '', missing: 'Only one leg of the forward/swap is in the file: its market value needs both legs.' };
  let c1 = f.leg1_currency;
  let c2 = f.leg2_currency;
  let assumed = '';
  if (isSwap) {
    if (!c1 && rowCcy) [c1, assumed] = [rowCcy, ` (leg 1 in the row's currency ${rowCcy})`];
    if (!c2 && rowCcy) [c2, assumed] = [rowCcy, `${assumed} (leg 2 in the row's currency ${rowCcy})`];
  } else if (rowCcy && !c1 !== !c2) {
    // One currency given: the other leg is in the row's currency, if that is a different one.
    const given = c1 ?? c2;
    if (given !== rowCcy) {
      if (!c1) [c1, assumed] = [rowCcy, ` (leg 1 in the row's currency ${rowCcy})`];
      else [c2, assumed] = [rowCcy, ` (leg 2 in the row's currency ${rowCcy})`];
    }
  }
  if (!c1 || !c2) return { method: '', missing: 'The currency of a forward/swap leg is not in the file: its market value is not estimated.' };
  // Who receives what: leg 1 unless the signs say leg 2.
  const swapRoles = a1 < 0 && a2 > 0;
  const [rAmt, rCcy, rLeg, pAmt, pCcy, pLeg] = swapRoles ? [a2, c2, 2, a1, c1, 1] : [a1, c1, 1, a2, c2, 2];
  const rr = rate(rCcy);
  const pr = rate(pCcy);
  if (rr === undefined || pr === undefined) return { method: '', missing: `No FX rate for ${rr === undefined ? rCcy : pCcy}: the forward/swap is not valued from its legs.` };
  const value = round(Math.abs(rAmt) * rr - Math.abs(pAmt) * pr, 2);
  const pc = portfolioCcy ?? 'portfolio currency';
  const method = `Leg ${rLeg} received ${fmtAmount(Math.abs(rAmt))} ${rCcy} × ${rr} − leg ${pLeg} paid ${fmtAmount(Math.abs(pAmt))} ${pCcy} × ${pr} = ${fmtAmount(value)} ${pc}${assumed}`;
  return { value, method };
}
