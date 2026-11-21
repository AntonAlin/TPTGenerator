/**
 * Generate a random, messy holdings file plus an answer key, for testing the
 * converter end to end.
 *
 *   npx tsx scripts/random-portfolio.ts <outDir> [seed]
 *
 * The file mixes equities, government / corporate / covered bonds, FRNs, funds,
 * ETFs, cash, FX forwards and futures, with: a random header language
 * (EN/SV/DE/FR), xlsx or csv (with that language's number format), title rows,
 * section headings, sub-totals and a total row, a mixed "holding" column
 * (shares / nominal / notional / contracts / cash), a notes column, and — at
 * random — a forward whose notional is shown in the market value columns.
 * All data is fictional; identifiers have valid check digits.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';

export interface TruthRow {
  name: string;
  id: string;
  kind: 'equity' | 'gov_bond' | 'corp_bond' | 'covered' | 'frn' | 'fund' | 'etf' | 'cash' | 'forward' | 'future';
  currency: string;
  /** What the "holding" cell really is. */
  holdingIs: 'quantity' | 'nominal' | 'cash' | 'notional' | 'contracts';
  holding: number;
  price?: number;
  /** True market values (clean). For a forward shown with its notional, the file does not contain these. */
  mvLocal: number;
  mvPortfolio: number;
  /** Expected CIC category (3rd character). */
  cicCategory: string;
  notionalShownAsValue?: boolean;
}

export interface Truth {
  seed: number;
  file: string;
  language: 'en' | 'sv' | 'de' | 'fr';
  format: 'xlsx' | 'csv' | 'xls';
  baseCurrency: string;
  valuationDate: string;
  rows: TruthRow[];
  /** Column header → canonical field the app should map it to. */
  columns: Record<string, string>;
  totalPortfolioValue: number;
}

// --- deterministic PRNG -------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isin(prefix: string, body: string): string {
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

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

const LANG = {
  en: {
    title: 'Portfolio holdings report', asOf: 'As of', name: 'Security', id: 'ISIN', holding: 'Holding', price: 'Price', ccy: 'CCY',
    mvLocal: 'Market value (local)', mvPort: (c: string) => `Market value ${c}`, weight: 'Weight %', maturity: 'Maturity', notes: 'Comments',
    sections: { equity: 'Equities', bonds: 'Bonds', funds: 'Funds', cash: 'Cash', derivatives: 'Derivatives' }, subtotal: 'Subtotal', total: 'Total',
  },
  sv: {
    title: 'Innehavsrapport', asOf: 'Per', name: 'Värdepapper', id: 'ISIN-kod', holding: 'Antal/Nominellt', price: 'Kurs', ccy: 'Valuta',
    mvLocal: 'Marknadsvärde lokal', mvPort: (c: string) => `Marknadsvärde ${c}`, weight: 'Andel %', maturity: 'Förfallodag', notes: 'Kommentar',
    sections: { equity: 'Aktier', bonds: 'Obligationer', funds: 'Fonder', cash: 'Likvida medel', derivatives: 'Derivat' }, subtotal: 'Summa', total: 'Totalt',
  },
  de: {
    title: 'Depotauszug', asOf: 'Stichtag', name: 'Wertpapierbezeichnung', id: 'ISIN', holding: 'Bestand', price: 'Kurs', ccy: 'Währung',
    mvLocal: 'Kurswert lokal', mvPort: (c: string) => `Kurswert ${c}`, weight: 'Anteil %', maturity: 'Fälligkeit', notes: 'Bemerkung',
    sections: { equity: 'Aktien', bonds: 'Anleihen', funds: 'Fonds', cash: 'Bankguthaben', derivatives: 'Derivate' }, subtotal: 'Zwischensumme', total: 'Summe',
  },
  fr: {
    title: 'Inventaire du portefeuille', asOf: 'Date de valorisation', name: 'Libellé', id: 'Code ISIN', holding: 'Quantité/Nominal', price: 'Cours', ccy: 'Devise',
    mvLocal: 'Valorisation devise', mvPort: (c: string) => `Valorisation ${c}`, weight: 'Poids %', maturity: 'Échéance', notes: 'Commentaire',
    sections: { equity: 'Actions', bonds: 'Obligations', funds: 'OPCVM', cash: 'Liquidités', derivatives: 'Dérivés' }, subtotal: 'Sous-total', total: 'Total',
  },
} as const;

const FX: Record<string, number> = { SEK: 1, EUR: 11.5, USD: 10.5, NOK: 0.98, DKK: 1.54, GBP: 13.3 };
const EQUITY_COUNTRIES: [string, string][] = [['SE', 'SEK'], ['SE', 'SEK'], ['DE', 'EUR'], ['FR', 'EUR'], ['US', 'USD'], ['US', 'USD'], ['GB', 'GBP'], ['NO', 'NOK'], ['FI', 'EUR'], ['DK', 'DKK']];
const SOVEREIGNS: [string, string, string][] = [['SE', 'SEK', 'SWEDEN'], ['DE', 'EUR', 'BUND'], ['FR', 'EUR', 'FRANCE OAT'], ['US', 'USD', 'UST'], ['GB', 'GBP', 'UKT']];
const SYL = ['nor', 'vik', 'sand', 'berg', 'atl', 'tel', 'gen', 'ax', 'lux', 'mar', 'tor', 'ika', 'lun', 'ess', 'kin', 'ro', 'max', 'tri', 'on', 'ex', 'vol', 'dal'];
const SUFFIX: Record<string, string[]> = { SE: ['AB', 'AB ser. B'], DE: ['AG', 'SE'], FR: ['SA'], US: ['Inc', 'Corp'], GB: ['plc'], NO: ['ASA'], FI: ['Oyj'], DK: ['A/S'] };

export interface GenerateOptions {
  /** Force the header language (default: random from the seed). */
  language?: 'en' | 'sv' | 'de' | 'fr';
  /** Force the file format; xls (legacy Excel 97-2003) is only produced when asked for. */
  format?: 'xlsx' | 'csv' | 'xls';
}

export function generatePortfolio(seed: number, outDir: string, opts: GenerateOptions = {}): Truth {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('');
  const company = () => {
    const n = Array.from({ length: int(2, 3) }, () => pick(SYL)).join('');
    return n[0].toUpperCase() + n.slice(1);
  };

  // The draws happen even when overridden, so a seed gives the same holdings whatever the options.
  const randomLanguage = pick(['en', 'sv', 'de', 'fr'] as const);
  const language = opts.language ?? randomLanguage;
  const L = LANG[language];
  const randomFormat = rnd() < 0.5 ? 'xlsx' : 'csv';
  const format = opts.format ?? randomFormat;
  const base = pick(['SEK', 'EUR'] as const);
  const fx = (c: string) => FX[c] / FX[base];
  const valuationDate = '2026-09-30';
  const rows: TruthRow[] = [];

  // Equities
  for (let i = 0, n = int(5, 12); i < n; i++) {
    const [cc, ccy] = pick(EQUITY_COUNTRIES);
    const name = `${company()} ${pick(SUFFIX[cc])}`;
    const qty = int(1, 400) * pick([10, 50, 100]);
    const price = round(pick([5 + rnd() * 50, 40 + rnd() * 400, 200 + rnd() * 2500]), 2);
    rows.push({ name, id: isin(cc, digits(9)), kind: 'equity', currency: ccy, holdingIs: 'quantity', holding: qty, price, mvLocal: round(qty * price), mvPortfolio: 0, cicCategory: '3' });
  }
  // Bonds
  const date = () => {
    const y = int(2027, 2040);
    const m = int(1, 12);
    const d = int(1, 28);
    return { y, m, d, text: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}` };
  };
  for (let i = 0, n = int(3, 8); i < n; i++) {
    const kind = pick(['gov_bond', 'gov_bond', 'corp_bond', 'corp_bond', 'covered', 'frn'] as const);
    const nominal = int(1, 50) * 100_000;
    const price = round(85 + rnd() * 25, 3);
    const cpn = pick([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.25, 4, 4.5, 5]);
    const dt = date();
    let name: string;
    let cc: string;
    let ccy: string;
    if (kind === 'gov_bond') {
      const s = pick(SOVEREIGNS);
      [cc, ccy] = [s[0], s[1]];
      name = `${s[2]} ${cpn}% ${dt.text}`;
    } else if (kind === 'covered') {
      [cc, ccy] = pick([['SE', 'SEK'], ['DK', 'DKK'], ['DE', 'EUR']] as const);
      name = `${company().toUpperCase()} HYPOTEK COVERED ${cpn}% ${dt.text}`;
    } else {
      [cc, ccy] = pick(EQUITY_COUNTRIES);
      name = kind === 'frn' ? `${company().toUpperCase()} ${pick(SUFFIX[cc]).toUpperCase()} FRN ${dt.y}` : `${company().toUpperCase()} ${pick(SUFFIX[cc]).toUpperCase()} ${cpn}% ${dt.text}`;
    }
    rows.push({
      name,
      id: isin(rnd() < 0.3 && kind !== 'gov_bond' ? 'XS' : cc, digits(9)),
      kind,
      currency: ccy,
      holdingIs: 'nominal',
      holding: nominal,
      price: kind === 'frn' ? round(99 + rnd() * 2, 3) : price,
      mvLocal: 0,
      mvPortfolio: 0,
      cicCategory: kind === 'gov_bond' ? '1' : '2',
    });
  }
  for (const r of rows) if (r.holdingIs === 'nominal') r.mvLocal = round((r.holding * r.price!) / 100);
  // Funds and ETFs
  for (let i = 0, n = int(1, 4); i < n; i++) {
    const etf = rnd() < 0.4;
    const ccy = pick(['SEK', 'EUR', 'USD'] as const);
    const name = etf ? `${company()} MSCI World UCITS ETF ${ccy}` : `${company()} ${pick(['Global Equity', 'Short Bond', 'Sverige', 'Europa', 'High Yield'])} Fund ${pick(['A', 'I', 'B'])}`;
    const units = round(100 + rnd() * 50_000, 4);
    const price = round(10 + rnd() * 300, 4);
    rows.push({ name, id: isin(pick(['LU', 'IE', 'SE']), digits(9)), kind: etf ? 'etf' : 'fund', currency: ccy, holdingIs: 'quantity', holding: units, price, mvLocal: round(units * price), mvPortfolio: 0, cicCategory: '4' });
  }
  // Cash
  for (const ccy of [base, ...(rnd() < 0.6 ? ['USD'] : [])]) {
    const amount = round(int(50, 5000) * 1000 + rnd() * 1000);
    rows.push({ name: `${L.sections.cash} ${ccy}`, id: '', kind: 'cash', currency: ccy, holdingIs: 'cash', holding: amount, mvLocal: amount, mvPortfolio: 0, cicCategory: '7' });
  }
  // Derivatives
  const forwards = int(0, 2);
  for (let i = 0; i < forwards; i++) {
    const notional = int(1, 40) * 100_000;
    const ccy = 'USD';
    rows.push({ name: `FX FWD ${base}/${ccy} ${['15-DEC-2026', '17-MAR-2027'][i]}`, id: `FWD-${digits(4)}`, kind: 'forward', currency: ccy, holdingIs: 'notional', holding: notional, mvLocal: round((rnd() - 0.5) * notional * 0.02), mvPortfolio: 0, cicCategory: 'E' });
  }
  if (rnd() < 0.5) {
    const contracts = int(1, 30);
    rows.push({ name: `EURO STOXX 50 FUT ${pick(['DEC26', 'MAR27'])}`, id: `FUT-${digits(4)}`, kind: 'future', currency: 'EUR', holdingIs: 'contracts', holding: contracts, price: round(4500 + rnd() * 800, 1), mvLocal: 0, mvPortfolio: 0, cicCategory: 'A' });
  }
  for (const r of rows) r.mvPortfolio = round(r.mvLocal * fx(r.currency));
  const total = round(rows.reduce((a, r) => a + r.mvPortfolio, 0));

  // A forward whose notional is shown as its market value (only with a total row to give it away).
  const notionalBug = forwards > 0 && rnd() < 0.6;
  if (notionalBug) rows.find((r) => r.kind === 'forward')!.notionalShownAsValue = true;

  // --- layout -----------------------------------------------------------------
  const withWeight = rnd() < 0.7;
  const withMaturity = rnd() < 0.5;
  const withSections = rnd() < 0.6;
  const withSubtotals = withSections && rnd() < 0.6;
  const header = [L.name, L.id, L.holding, L.price, L.ccy, L.mvLocal, L.mvPort(base), ...(withWeight ? [L.weight] : []), ...(withMaturity ? [L.maturity] : []), L.notes];
  const columns: Record<string, string> = {
    [L.name]: 'security_name', [L.id]: 'isin', [L.holding]: 'amount_mixed|quantity', [L.price]: 'price', [L.ccy]: 'currency',
    [L.mvLocal]: 'market_value_local', [L.mvPort(base)]: 'market_value_portfolio', [L.notes]: 'ignore',
    ...(withWeight ? { [L.weight]: 'weight' } : {}), ...(withMaturity ? { [L.maturity]: 'maturity_date' } : {}),
  };
  const groupOf = (r: TruthRow) => (r.kind === 'equity' ? 'equity' : r.kind === 'fund' || r.kind === 'etf' ? 'funds' : r.kind === 'cash' ? 'cash' : r.kind === 'forward' || r.kind === 'future' ? 'derivatives' : 'bonds') as keyof typeof L.sections;
  const order: (keyof typeof L.sections)[] = ['equity', 'bonds', 'funds', 'derivatives', 'cash'];
  const sorted = order.flatMap((g) => rows.filter((r) => groupOf(r) === g));
  rows.splice(0, rows.length, ...sorted);

  const NOTES = ['', '', '', '', 'Check price', 'Pledged', 'New position', 'Corporate action pending'];
  const cellsFor = (r: TruthRow) => {
    const shownLocal = r.notionalShownAsValue ? r.holding : r.mvLocal;
    const shownPort = r.notionalShownAsValue ? round(r.holding * fx(r.currency)) : r.mvPortfolio;
    const mat = r.kind.includes('bond') || r.kind === 'covered' ? (r.name.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] ?? '') : '';
    return [
      r.name, r.id || null, r.holding, r.price ?? null, r.currency, shownLocal, shownPort,
      ...(withWeight ? [round((r.mvPortfolio / total) * 100, 4)] : []),
      ...(withMaturity ? [mat || null] : []),
      pick(NOTES) || null,
    ];
  };
  const aoa: unknown[][] = [[L.title], [`${L.asOf} 30/09/2026`], [], header];
  for (const g of order) {
    const group = rows.filter((r) => groupOf(r) === g);
    if (!group.length) continue;
    if (withSections) aoa.push([L.sections[g]]);
    for (const r of group) aoa.push(cellsFor(r));
    if (withSubtotals) {
      const sub = round(group.reduce((a, r) => a + r.mvPortfolio, 0));
      const row: unknown[] = header.map(() => null);
      row[0] = `${L.subtotal} ${L.sections[g].toLowerCase()}`;
      row[6] = sub;
      aoa.push(row);
    }
    if (rnd() < 0.3) aoa.push([]);
  }
  const totalRow: unknown[] = header.map(() => null);
  totalRow[0] = L.total;
  totalRow[6] = total;
  if (withWeight) totalRow[7] = 100;
  aoa.push(totalRow);

  mkdirSync(outDir, { recursive: true });
  const file = `random_${language}_${seed}.${format}`;
  if (format === 'xlsx' || format === 'xls') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Holdings');
    writeFileSync(resolve(outDir, file), XLSX.write(wb, { type: 'buffer', bookType: format === 'xls' ? 'biff8' : 'xlsx' }) as Buffer);
  } else {
    const locale = { en: 'en-US', sv: 'sv-SE', de: 'de-DE', fr: 'fr-FR' }[language];
    const delim = language === 'en' ? ',' : ';';
    const fmt = (v: unknown, j: number) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') {
        const dec = j === 2 && !Number.isInteger(v) ? 4 : j === 3 ? 3 : Number.isInteger(v) && j === 2 ? 0 : 2;
        const s = v.toLocaleString(locale, { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 4) }).replace(/−/g, '-');
        return s.includes(delim) ? `"${s}"` : s;
      }
      const s = String(v);
      return s.includes(delim) || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    writeFileSync(resolve(outDir, file), `﻿${aoa.map((r) => r.map(fmt).join(delim)).join('\r\n')}\r\n`);
  }
  const truth: Truth = { seed, file, language, format, baseCurrency: base, valuationDate, rows, columns, totalPortfolioValue: total };
  writeFileSync(resolve(outDir, `${file}.truth.json`), JSON.stringify(truth, null, 2));
  return truth;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ?? 'random-portfolios';
  const seed = Number(process.argv[3] ?? Math.floor(Math.random() * 1e6));
  const t = generatePortfolio(seed, outDir);
  console.log(`Wrote ${resolve(outDir, t.file)} (seed ${seed}, ${t.language}, ${t.format}, base ${t.baseCurrency}, ${t.rows.length} holdings)`);
}
