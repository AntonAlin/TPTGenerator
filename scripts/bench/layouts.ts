/**
 * Benchmark layouts: how custodians, fund administrators and portfolio systems lay out a holdings
 * file. Each layout is written from scratch to resemble a common kind of export (headers, sections,
 * number formats, scale, extra columns); none is a copy of a real institution's file.
 *
 * A column says which input field the converter should map it to (`expect`, alternatives with |)
 * and how to write each holding's cell.
 */
import { round, type BenchHolding, type BenchPortfolio } from './holdings.ts';

export type Cell = string | number | Date | null;

export interface Ctx {
  p: BenchPortfolio;
  fund: string;
  date: string;
  /** Divisor applied to amounts in a scaled layout (1000 for TSEK / 000s). */
  scale: number;
}

export interface Column {
  header: string;
  expect: string;
  cell: (h: BenchHolding, c: Ctx) => Cell;
}

export interface Layout {
  id: string;
  label: string;
  language: 'en' | 'sv' | 'de' | 'fr';
  format: 'xlsx' | 'csv' | 'xls';
  /** CSV: delimiter and number locale. */
  delimiter?: string;
  locale?: string;
  base?: string;
  /** Rows above the header. */
  preamble?: (c: Ctx) => Cell[][];
  columns: Column[];
  sections?: Record<string, string>;
  subtotalLabel?: string;
  /** Total row: label, and the column whose total it holds. */
  total?: { label: string; column: string };
  /** Header repeated every n data rows (page breaks). */
  repeatHeaderEvery?: number;
  /** Divisor for amounts (1000 = thousands). */
  scale?: number;
  /** Several funds and dates in one table: [fund names, dates]. The converter's default is the first fund on the latest date. */
  multi?: { funds: string[]; dates: string[] };
  /** Whether the file carries enough for a market value of this holding (default: yes). */
  mvKnown?: (h: BenchHolding) => boolean;
}

const iso = (d: string) => d;
const dmy = (d: string, sep = '/') => `${d.slice(8, 10)}${sep}${d.slice(5, 7)}${sep}${d.slice(0, 4)}`;
const sectionOf = (h: BenchHolding) =>
  h.kind === 'equity' ? 'equity' : h.kind === 'fund' || h.kind === 'etf' ? 'funds' : h.kind === 'cash' ? 'cash' : ['forward', 'future', 'option', 'irs'].includes(h.kind) ? 'derivatives' : 'bonds';
export const SECTION_ORDER = ['equity', 'bonds', 'funds', 'derivatives', 'cash'] as const;
export { sectionOf };

/** What the file shows in its market value columns: a forward's notional, when that is the bug. */
const shownLocal = (h: BenchHolding, c: Ctx) => round((h.notionalShownAsValue ? h.holding : h.mvLocal) / c.scale, c.scale > 1 ? 1 : 2);
const shownPort = (h: BenchHolding, c: Ctx) => round((h.notionalShownAsValue ? h.holding * c.p.fx[h.currency] : h.mvPortfolio) / c.scale, c.scale > 1 ? 1 : 2);
const weightPct = (h: BenchHolding, c: Ctx) => round((h.mvPortfolio / c.p.total) * 100, 4);
const weightFrac = (h: BenchHolding, c: Ctx) => round(h.mvPortfolio / c.p.total, 6);
const holding = (h: BenchHolding) => h.holding;
const isinOr = (h: BenchHolding) => h.isin ?? h.ticker ?? null;
const NOTES = ['', '', '', '', 'Check price', 'Pledged', 'New position'];
const note = (h: BenchHolding) => NOTES[h.name.length % NOTES.length] || null;
const derivative = (h: BenchHolding) => ['forward', 'future', 'option', 'irs'].includes(h.kind);

export const LAYOUTS: Layout[] = [
  {
    id: 'sv-custody',
    label: 'Swedish custodian position report: title rows, sections, subtotals, total, mixed holding column',
    language: 'sv',
    format: 'xlsx',
    base: 'SEK',
    preamble: (c) => [['Innehavsrapport'], [`Per ${c.date}`], []],
    columns: [
      { header: 'Värdepapper', expect: 'security_name', cell: (h) => h.name },
      { header: 'ISIN-kod', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Antal/Nominellt', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Kurs', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Valuta', expect: 'currency', cell: (h) => h.currency },
      { header: 'Marknadsvärde lokal', expect: 'market_value_local', cell: shownLocal },
      { header: 'Marknadsvärde SEK', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Andel %', expect: 'weight', cell: weightPct },
      { header: 'Kommentar', expect: 'ignore', cell: note },
    ],
    sections: { equity: 'Aktier', bonds: 'Obligationer', funds: 'Fonder', derivatives: 'Derivat', cash: 'Likvida medel' },
    subtotalLabel: 'Summa',
    total: { label: 'Totalt', column: 'Marknadsvärde SEK' },
  },
  {
    id: 'en-fund-admin-multi',
    label: 'Fund administrator NAV pack: several funds on several dates in one table, no total',
    language: 'en',
    format: 'csv',
    delimiter: ',',
    locale: 'en-US',
    base: 'EUR',
    multi: { funds: ['ALPHA EQ FUND', 'BETA BALANCED FUND'], dates: ['2026-08-31', '2026-09-30'] },
    columns: [
      { header: 'Fund Code', expect: 'ignore', cell: (_h, c) => c.fund },
      { header: 'Valuation Date', expect: 'ignore', cell: (_h, c) => iso(c.date) },
      { header: 'Security ID', expect: 'isin|other_identifier', cell: isinOr },
      { header: 'Security Description', expect: 'security_name', cell: (h) => h.name },
      { header: 'Asset Class', expect: 'asset_type', cell: (h) => h.assetType },
      { header: 'Shares/Par', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Local Price', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Local Currency', expect: 'currency', cell: (h) => h.currency },
      { header: 'Local Market Value', expect: 'market_value_local', cell: shownLocal },
      { header: 'Base Market Value', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Accrued Interest Local', expect: 'accrued_interest', cell: (h) => h.accruedLocal ?? null },
      { header: '% of NAV', expect: 'weight', cell: weightPct },
    ],
  },
  {
    id: 'en-global-custodian',
    label: 'Global custodian holdings: account and as-of columns, ticker, country, exchange rate, accrued income',
    language: 'en',
    format: 'xlsx',
    base: 'USD',
    columns: [
      { header: 'Account Number', expect: 'ignore', cell: () => 'ACC-4471' },
      { header: 'As Of Date', expect: 'ignore', cell: (_h, c) => c.date },
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Ticker', expect: 'other_identifier', cell: (h) => h.ticker ?? null },
      { header: 'Description', expect: 'security_name', cell: (h) => h.name },
      { header: 'Asset Type', expect: 'asset_type', cell: (h) => h.assetType },
      { header: 'Country of Issue', expect: 'country', cell: (h) => h.country || null },
      { header: 'Shares/Par', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Price', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Currency', expect: 'currency', cell: (h) => h.currency },
      { header: 'Exchange Rate', expect: 'fx_rate', cell: (h, c) => round(c.p.fx[h.currency], 6) },
      { header: 'Market Value Local', expect: 'market_value_local', cell: shownLocal },
      { header: 'Market Value Base', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Accrued Income Local', expect: 'accrued_interest', cell: (h) => h.accruedLocal ?? null },
    ],
  },
  {
    id: 'de-depot',
    label: 'German depot statement: semicolon CSV, decimal comma, repeated header after page breaks, accrued interest, coupon, maturity',
    language: 'de',
    format: 'csv',
    delimiter: ';',
    locale: 'de-DE',
    base: 'EUR',
    preamble: (c) => [['Depotauszug'], [`Stichtag ${dmy(c.date, '.')}`]],
    columns: [
      { header: 'Gattungsbezeichnung', expect: 'security_name', cell: (h) => h.name },
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Stück/Nominale', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Kurs', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Währung', expect: 'currency', cell: (h) => h.currency },
      { header: 'Kurswert EUR', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Stückzinsen', expect: 'accrued_interest', cell: (h) => h.accruedLocal ?? null },
      { header: 'Kupon', expect: 'coupon', cell: (h) => h.coupon ?? null },
      { header: 'Fälligkeit', expect: 'maturity_date', cell: (h) => (h.maturity && !derivative(h) ? dmy(h.maturity, '.') : null) },
    ],
    repeatHeaderEvery: 15,
    total: { label: 'Summe', column: 'Kurswert EUR' },
  },
  {
    id: 'fr-inventaire',
    label: 'French portfolio inventory as legacy .xls: comment column, weights in %',
    language: 'fr',
    format: 'xls',
    base: 'EUR',
    preamble: (c) => [['Inventaire du portefeuille'], [`Date de valorisation ${dmy(c.date)}`], []],
    columns: [
      { header: 'Libellé', expect: 'security_name', cell: (h) => h.name },
      { header: 'Code ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Quantité/Nominal', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Cours', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Devise', expect: 'currency', cell: (h) => h.currency },
      { header: 'Valorisation devise', expect: 'market_value_local', cell: shownLocal },
      { header: 'Valorisation EUR', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Poids %', expect: 'weight', cell: weightPct },
      { header: 'Commentaire', expect: 'ignore', cell: note },
    ],
    sections: { equity: 'Actions', bonds: 'Obligations', funds: 'OPCVM', derivatives: 'Dérivés', cash: 'Liquidités' },
    total: { label: 'Total', column: 'Valorisation EUR' },
  },
  {
    id: 'sv-tsek',
    label: 'Swedish report with amounts in thousands (TSEK) and no local value column',
    language: 'sv',
    format: 'xlsx',
    base: 'SEK',
    scale: 1000,
    preamble: (c) => [['Innehav'], [`Per ${c.date}`], ['Belopp i tusental kronor (TSEK)'], []],
    columns: [
      { header: 'Värdepapper', expect: 'security_name', cell: (h) => h.name },
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Antal', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Kurs', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Valuta', expect: 'currency', cell: (h) => h.currency },
      { header: 'Marknadsvärde (TSEK)', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Andel %', expect: 'weight', cell: weightPct },
    ],
    total: { label: 'Summa', column: 'Marknadsvärde (TSEK)' },
  },
  {
    id: 'en-thousands',
    label: 'US-style report with values in thousands ("000s") in both value columns',
    language: 'en',
    format: 'csv',
    delimiter: ',',
    locale: 'en-US',
    base: 'USD',
    scale: 1000,
    preamble: (c) => [['Portfolio Valuation'], [`As of ${c.date}`]],
    columns: [
      { header: 'Description', expect: 'security_name', cell: (h) => h.name },
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Shares/Par', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Price', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Currency', expect: 'currency', cell: (h) => h.currency },
      { header: 'Market Value Local (000s)', expect: 'market_value_local', cell: shownLocal },
      { header: 'Market Value USD (000s)', expect: 'market_value_portfolio', cell: shownPort },
    ],
    total: { label: 'Total', column: 'Market Value USD (000s)' },
  },
  {
    id: 'en-portfolio-system',
    label: 'Portfolio system export (Nexus-like): date and portfolio columns, instrument type, many model inputs, sparse market value override',
    language: 'en',
    format: 'xlsx',
    base: 'SEK',
    multi: { funds: ['Demo: Growth Fund', 'Demo: Income Fund'], dates: ['2026-09-30'] },
    columns: [
      { header: 'Date', expect: 'ignore', cell: (_h, c) => c.date },
      { header: 'Portfolio', expect: 'ignore', cell: (_h, c) => c.fund },
      { header: 'Instrument type', expect: 'asset_type', cell: (h) => h.assetType },
      { header: 'Name', expect: 'security_name', cell: (h) => h.name },
      { header: 'Ticker / ID', expect: 'other_identifier', cell: (h) => h.ticker ?? null },
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Issuer', expect: 'issuer_name', cell: (h) => h.issuer ?? null },
      { header: 'Quantity', expect: 'quantity|amount_mixed|nominal', cell: holding },
      { header: 'Price', expect: 'price', cell: (h) => (derivative(h) && h.kind !== 'future' ? null : (h.price ?? null)) },
      { header: 'Currency', expect: 'currency', cell: (h) => h.currency },
      { header: 'Beta', expect: 'ignore', cell: (h) => (h.kind === 'equity' ? 1.05 : null) },
      { header: 'Avg daily volume', expect: 'ignore', cell: (h) => (h.kind === 'equity' ? 1_200_000 + h.holding : null) },
      { header: 'Duration (yrs)', expect: 'modified_duration', cell: (h) => h.modifiedDuration ?? null },
      { header: 'Yield %', expect: 'yield', cell: (h) => h.yieldPct ?? null },
      { header: 'Coupon %', expect: 'coupon', cell: (h) => h.coupon ?? null },
      { header: 'Maturity / expiry', expect: 'maturity_date', cell: (h) => h.maturity ?? null },
      { header: 'Rating', expect: 'rating', cell: (h) => h.rating ?? null },
      { header: 'Multiplier', expect: 'contract_size', cell: (h) => h.contractSize ?? null },
      { header: 'Strike', expect: 'strike', cell: (h) => h.strike ?? null },
      { header: 'Call / put', expect: 'call_put', cell: (h) => h.callPut ?? null },
      { header: 'Underlying price', expect: 'underlying_price', cell: (h) => h.underlyingPrice ?? null },
      // As in Nexus: no value for a forward, only its legs (the converter values it from them).
      { header: 'Market value override', expect: 'market_value_local', cell: (h) => (derivative(h) && h.kind !== 'forward' ? h.mvLocal : null) },
      { header: 'Reported delta', expect: 'delta', cell: (h) => h.delta ?? null },
      { header: 'Buy currency', expect: 'leg1_currency', cell: (h) => h.legs?.buy.ccy ?? null },
      { header: 'Buy amount', expect: 'leg1_amount', cell: (h) => h.legs?.buy.amount ?? null },
      { header: 'Sell currency', expect: 'leg2_currency', cell: (h) => h.legs?.sell.ccy ?? null },
      { header: 'Sell amount', expect: 'leg2_amount', cell: (h) => h.legs?.sell.amount ?? null },
    ],
  },
  {
    id: 'generic-headers',
    label: 'Meaningless headers (Col1…): everything read from the values',
    language: 'en',
    format: 'xlsx',
    base: 'EUR',
    columns: [
      { header: 'Col1', expect: 'security_name', cell: (h) => h.name },
      { header: 'Col2', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Col3', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Col4', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Col5', expect: 'currency', cell: (h) => h.currency },
      { header: 'Col6', expect: 'market_value_local', cell: shownLocal },
      { header: 'Col7', expect: 'market_value_portfolio', cell: shownPort },
    ],
    total: { label: 'Total', column: 'Col7' },
  },
  {
    id: 'en-bond-fund',
    label: 'Bond fund report: clean and dirty prices, accrued, yield, duration, rating, weights as fractions',
    language: 'en',
    format: 'csv',
    delimiter: ';',
    locale: 'en-GB',
    base: 'EUR',
    columns: [
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Issuer', expect: 'issuer_name', cell: (h) => h.issuer ?? null },
      { header: 'Security Name', expect: 'security_name', cell: (h) => h.name },
      { header: 'Coupon', expect: 'coupon', cell: (h) => h.coupon ?? null },
      { header: 'Maturity Date', expect: 'maturity_date', cell: (h) => (h.maturity && !derivative(h) ? dmy(h.maturity) : null) },
      { header: 'Nominal / Shares', expect: 'amount_mixed|nominal|quantity', cell: holding },
      { header: 'Clean Price', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Dirty Price', expect: 'dirty_price', cell: (h) => (h.accruedLocal !== undefined && h.price !== undefined ? round(h.price + (h.accruedLocal / h.holding) * 100, 4) : null) },
      { header: 'Accrued Interest', expect: 'accrued_interest', cell: (h) => h.accruedLocal ?? null },
      { header: 'Currency', expect: 'currency', cell: (h) => h.currency },
      { header: 'Market Value (EUR)', expect: 'market_value_portfolio', cell: shownPort },
      { header: 'Yield to Maturity', expect: 'yield', cell: (h) => h.yieldPct ?? null },
      { header: 'Mod. Duration', expect: 'modified_duration', cell: (h) => h.modifiedDuration ?? null },
      { header: 'Rating', expect: 'rating', cell: (h) => h.rating ?? null },
      { header: 'Weight', expect: 'weight', cell: weightFrac },
    ],
  },
  {
    id: 'en-derivatives',
    label: 'Risk report with derivative terms: contracts/notional, contract size, strike, call/put, underlying, delta, MTM',
    language: 'en',
    format: 'xlsx',
    base: 'SEK',
    columns: [
      { header: 'Instrument', expect: 'security_name', cell: (h) => h.name },
      { header: 'Identifier', expect: 'isin|other_identifier', cell: isinOr },
      { header: 'Type', expect: 'asset_type', cell: (h) => h.assetType },
      { header: 'Position', expect: 'amount_mixed|quantity|nominal', cell: holding },
      { header: 'Price', expect: 'price', cell: (h) => h.price ?? null },
      { header: 'Currency', expect: 'currency', cell: (h) => h.currency },
      { header: 'Contract Size', expect: 'contract_size', cell: (h) => h.contractSize ?? null },
      { header: 'Strike', expect: 'strike', cell: (h) => h.strike ?? null },
      { header: 'Call/Put', expect: 'call_put', cell: (h) => (h.callPut ? h.callPut.toUpperCase() : null) },
      { header: 'Underlying', expect: 'underlying_name', cell: (h) => h.underlying ?? null },
      { header: 'Underlying Price', expect: 'underlying_price', cell: (h) => h.underlyingPrice ?? null },
      { header: 'Delta', expect: 'delta', cell: (h) => h.delta ?? null },
      { header: 'MTM (local)', expect: 'market_value_local', cell: shownLocal },
      { header: 'MTM (SEK)', expect: 'market_value_portfolio', cell: shownPort },
    ],
    total: { label: 'Total', column: 'MTM (SEK)' },
  },
  {
    id: 'uk-pence',
    label: 'UK report: equities priced in pence (GBp / GBX), values in pounds',
    language: 'en',
    format: 'csv',
    delimiter: ',',
    locale: 'en-GB',
    base: 'GBP',
    preamble: (c) => [['Valuation report'], [`Valuation date: ${dmy(c.date)}`], []],
    columns: [
      { header: 'Stock', expect: 'security_name', cell: (h) => h.name },
      { header: 'ISIN', expect: 'isin', cell: (h) => h.isin ?? null },
      { header: 'Holding', expect: 'amount_mixed|quantity|nominal', cell: holding },
      // UK equities are quoted in pence; everything else in its own currency.
      { header: 'Price', expect: 'price', cell: (h) => (h.kind === 'equity' && h.currency === 'GBP' ? round(h.price! * 100, 2) : (h.price ?? null)) },
      { header: 'Price Currency', expect: 'currency', cell: (h) => (h.kind === 'equity' && h.currency === 'GBP' ? 'GBX' : h.currency) },
      { header: 'Value (local)', expect: 'market_value_local', cell: shownLocal },
      { header: 'Value (GBP)', expect: 'market_value_portfolio', cell: shownPort },
    ],
    total: { label: 'Total', column: 'Value (GBP)' },
  },
];

/** Market value derivable when the layout has no value column for it (portfolio-system layout). */
export const mvKnownDefault = (layout: Layout, h: BenchHolding) =>
  layout.mvKnown ? layout.mvKnown(h) : true;
