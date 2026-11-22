/**
 * Build TPT files (one per fund, or one per share class) as rows of resolved
 * cells in the exact column order of the active spec. Every cell keeps its
 * provenance so the export can include a "source" sheet and the quality report
 * can explain every value.
 */
import { spec } from '../spec/index.ts';
import type { SpecField } from '../spec/types.ts';
import { ATTRS, type AttrKey } from '../derive/attributes.ts';
import type { ResolveResult, ResolvedHolding } from '../derive/resolve.ts';
import { derived, hasValue, minConfidence, missing, type Resolved } from '../derive/provenance.ts';
import { PORTFOLIO_FIELDS, baseCurrencyOf, resolvePortfolioField, type PortfolioState } from '../portfolio/portfolio.ts';
import type { FxEntry } from '../derive/valuation.ts';

/** TPT field id → resolved attribute. */
const ATTR_BY_FIELD = new Map<string, AttrKey>();
for (const a of ATTRS) for (const id of a.tpt) if (!ATTR_BY_FIELD.has(id)) ATTR_BY_FIELD.set(id, a.key);

const PORTFOLIO_IDS = new Set(PORTFOLIO_FIELDS.map((f) => f.id));
/** Amount fields expressed in the portfolio currency (converted for share classes in another currency). */
const PORTFOLIO_CCY_FIELDS = new Set(['24', '25', '28']);
const isScrField = (f: SpecField) => /SCR/i.test(f.section) || /^SCR_/i.test(f.header.replace(/^\d+[a-z]?_/, ''));

export interface TptFile {
  fileName: string;
  /** Share class label (undefined at fund level). */
  shareClass?: string;
  portfolioCurrency?: string;
  fields: SpecField[];
  /** One row per holding, one cell per spec field. */
  rows: Resolved[][];
  holdings: ResolvedHolding[];
}

export interface BuildOptions {
  freeText?: string;
  today?: string;
}

const isDerivative = (cic?: string) => !!cic && /^[A-F]$/.test(cic[2]);

/** Fields 27/28/30: exposure equals valuation for non-derivatives; notional for FX forwards, FRAs and CDS. */
function exposure(id: '27' | '28' | '30', h: ResolvedHolding, nav?: number): Resolved {
  const a = h.attrs;
  const cic = typeof a.cic.value === 'string' ? a.cic.value : undefined;
  if (!cic) return missing('No CIC: cannot tell whether this is a derivative.');
  if (!isDerivative(cic) && cic.slice(2) !== '22') {
    const src = id === '27' ? a.mv_local_dirty : id === '28' ? a.mv_port_dirty : a.weight;
    if (!hasValue(src)) return missing('No market valuation to use as exposure.');
    return derived(src.value, `Non-derivative: exposure equals the market valuation (field ${id === '27' ? '22' : id === '28' ? '24' : '26'}), per the definition of fields 27/28`, minConfidence(src.confidence, 'high'));
  }
  const notionalAllowed = cic[2] === 'E' || cic.slice(2) === 'F1';
  const nominal = a.nominal.value;
  if (notionalAllowed && typeof nominal === 'number') {
    if (id === '27') return derived(nominal, 'FX forward / FRA / CDS: exposure is the notional amount (field 27 comment)', 'medium');
    const fx = a.fx_rate.value;
    if (typeof fx !== 'number') return missing('No FX rate for the notional.');
    if (id === '28') return derived(Math.round(nominal * fx * 100) / 100, 'Notional × FX rate (field 27 comment)', 'medium');
    if (!nav) return missing('No NAV to compute the exposure weight.');
    return derived(Math.round(((nominal * fx) / nav) * 1e10) / 1e10, 'Notional exposure (portfolio ccy) ÷ NAV', 'medium');
  }
  // Futures and options on equities, currencies and commodities: the formula of the field 27
  // comment, quantity × contract size × underlying price (× delta for an option), all from the file.
  // A put's exposure is negative for a long position (field 28 comment). Interest rate futures and
  // options are left out: their exposure is on the cheapest-to-deliver bond, which a file rarely gives.
  const sub = cic.slice(2);
  // An equity total return swap or CFD: the equivalent position is its shares at the share price.
  const isFuture = sub === 'A1' || sub === 'A3' || sub === 'A5' || (sub === 'D4' && hasValue(a.quantity) && hasValue(a.underlying_price));
  const isOption = /^[BC][135]$/.test(sub);
  if (isFuture || isOption) {
    const num = (r: Resolved) => (hasValue(r) && typeof r.value === 'number' ? r.value : undefined);
    const q = num(a.quantity);
    const cs = num(a.contract_size) ?? (sub === 'D4' ? 1 : undefined);
    const up = num(a.underlying_price);
    const d = num(a.delta);
    const lacking = [q === undefined && 'quantity (field 18)', cs === undefined && 'contract size (field 20)', up === undefined && 'underlying price (field 72)', isOption && d === undefined && 'delta (field 93)'].filter(Boolean);
    if (lacking.length) return missing(`Exposure = quantity × contract size × underlying price${isOption ? ' × delta' : ''} (field 27 comment): the file has no ${lacking.join(', ')}.`);
    const put = isOption && cic[2] === 'C';
    const local = Math.round(q! * cs! * up! * (isOption ? Math.abs(d!) : 1) * (put ? -1 : 1) * 100) / 100;
    const conf = minConfidence(a.quantity.confidence, a.contract_size.confidence, a.underlying_price.confidence, isOption ? a.delta.confidence : 'high');
    const how = sub === 'D4' ? `Quantity ${q} × underlying share price ${up}: the equivalent position in the share (field 27 definition)` : `Quantity ${q} × contract size ${cs} × underlying price ${up}${isOption ? ` × delta ${Math.abs(d!)}` : ''}${put ? ', negative for a put held long' : ''} (field 27 comment)`;
    if (id === '27') return derived(local, how, conf, 'The underlying price is taken to be in the quotation currency (field 21).');
    const fx = a.fx_rate.value;
    if (typeof fx !== 'number') return missing('No FX rate for the exposure.');
    const port = Math.round(local * fx * 100) / 100;
    if (id === '28') return derived(port, `${how} × FX rate ${fx}`, conf);
    if (!nav) return missing('No NAV to compute the exposure weight.');
    return derived(Math.round((port / nav) * 1e10) / 1e10, 'Exposure in portfolio currency (field 28) ÷ NAV', conf);
  }
  return missing(sub === '22' ? 'Convertible bond: exposure needs the delta (field 28 comment); not derivable without market data.' : 'Derivative exposure needs a pricing model or data the file does not give (cheapest-to-deliver bond, swap or credit details).');
}

export function buildTptFiles(
  result: ResolveResult,
  portfolio: PortfolioState,
  fx: Record<string, FxEntry>,
  options: BuildOptions = {},
): TptFile[] {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const base = baseCurrencyOf(portfolio);
  const classes =
    portfolio.level === 'share_class'
      ? portfolio.shareClasses.map((c, i) => ({ values: { ...portfolio.values, ...c.values, '4': c.values['4'] || base || '' }, label: c.values['3'] || c.values['1'] || `Share class ${i + 1}` }))
      : [{ values: { ...portfolio.values }, label: undefined as string | undefined }];

  return classes.map((cls) => {
    const classCcy = cls.values['4'] || base;
    const classRate = classCcy && classCcy !== base ? fx[classCcy]?.rate : 1;
    const navField = (): Resolved => {
      const entered = resolvePortfolioField('5', cls.values, result.portfolio, today);
      if (hasValue(entered) || portfolio.level === 'share_class') return entered;
      return result.portfolio.nav;
    };

    const rows = result.rows.map((h) =>
      spec.fields.map((f): Resolved => {
        if (f.mustBeEmpty) return missing('No longer maintained by FinDatEx: must be left empty.');
        if (f.id === '1000') return derived(spec.meta.versionFieldValue, `Version of the active template (${spec.meta.version})`, 'high');
        if (PORTFOLIO_IDS.has(f.id)) return f.id === '5' ? navField() : resolvePortfolioField(f.id, cls.values, result.portfolio, today);
        if (isScrField(f)) return missing('SCR contributions are not computed by this tool (field 11 = N).');
        if (f.id === '27' || f.id === '28' || f.id === '30') {
          const e = exposure(f.id, h, typeof result.portfolio.nav.value === 'number' ? result.portfolio.nav.value : undefined);
          return PORTFOLIO_CCY_FIELDS.has(f.id) ? convert(e, classRate, classCcy, base) : e;
        }
        const attr = ATTR_BY_FIELD.get(f.id);
        if (!attr) return missing('Not in the file and not derivable.');
        const r = h.attrs[attr];
        return PORTFOLIO_CCY_FIELDS.has(f.id) ? convert(r, classRate, classCcy, base) : r;
      }),
    );

    const id1 = String(resolvePortfolioField('1', cls.values, result.portfolio, today).value ?? 'NOID');
    const valDate = (portfolio.values['6'] || today).replace(/-/g, '');
    const free = (options.freeText || 'TPT').replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40);
    const fileName = `${valDate}_TPT${spec.meta.fileNameVersionTag}_${id1.replace(/[^A-Za-z0-9-]+/g, '')}_${today.replace(/-/g, '')}_${free}`;
    return { fileName, shareClass: cls.label, portfolioCurrency: classCcy, fields: spec.fields, rows, holdings: result.rows };
  });
}

function convert(r: Resolved, rate: number | undefined, ccy: string | undefined, base: string | undefined): Resolved {
  if (rate === 1 || !hasValue(r) || typeof r.value !== 'number') return r;
  if (rate === undefined) return missing(`No FX rate for share class currency ${ccy}.`);
  return { ...r, value: Math.round((r.value / rate) * 100) / 100, source: r.source === 'file' ? 'derived' : r.source, method: `${r.method ?? ''} — converted from ${base} to share class currency ${ccy} at ${rate}`.trim(), confidence: minConfidence(r.confidence, 'high') };
}

/** Serialise a cell for xlsx/csv: numbers stay numbers for numeric fields; everything else is text. */
export function cellValue(f: SpecField, r: Resolved): string | number | undefined {
  if (!hasValue(r)) return undefined;
  if ((f.dataType === 'number' || f.dataType === 'integer') && typeof r.value === 'number') return r.value;
  if ((f.dataType === 'number' || f.dataType === 'integer') && typeof r.value === 'string' && /^-?\d+(\.\d+)?$/.test(r.value)) return Number(r.value);
  return String(r.value);
}
