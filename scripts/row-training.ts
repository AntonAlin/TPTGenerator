/**
 * Training rows for the row asset-class model: synthetic holdings of eleven kinds, written the many
 * ways files write them (full names, trader shorthand, names with no keyword at all), in tables
 * whose columns vary (a file with strike and delta, one with only name, amount and value), with
 * features computed by the app's own rowFeatures().
 *
 *   npx tsx scripts/row-training.ts [tables=4000] [seed=11] > training/data/rows.jsonl
 *
 * Deliberately not the benchmark's generator (scripts/bench/holdings.ts): the benchmark must score
 * the model on names and layouts it was not trained on.
 */
import { rowFeatures, ROW_FEATURE_NAMES, type RowInput } from '../src/derive/rowFeatures.ts';
import { ROW_CLASSES, type RowClass } from '../src/derive/rowClasses.ts';
import { mulberry32 } from './bench/holdings.ts';

const [tablesArg = '4000', seedArg = '11'] = process.argv.slice(2);
const rnd = mulberry32(Number(seedArg));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number) => rnd() < p;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const VALUATION = '2026-09-30';
const addDays = (days: number) => new Date(Date.parse(VALUATION) + days * 864e5).toISOString().slice(0, 10);
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const FUT_CODE = 'FGHJKMNQUVXZ';

function isin(prefix: string): string {
  const body = Array.from({ length: 9 }, () => int(0, 9)).join('');
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

const SYL = ['vol', 'eric', 'san', 'atl', 'hex', 'ess', 'tel', 'skan', 'nor', 'boli', 'alfa', 'inv', 'kin', 'lun', 'sie', 'bay', 'nes', 'ro', 'max', 'dal', 'vik', 'berg', 'gen', 'tor'];
const company = () => {
  const n = Array.from({ length: int(2, 3) }, () => pick(SYL)).join('');
  return n[0].toUpperCase() + n.slice(1);
};
const SUFFIX = ['AB', 'AB ser. B', 'B', 'A', 'AG', 'SE', 'SA', 'Inc', 'Corp', 'plc', 'ASA', 'Oyj', 'A/S', 'NV', 'Holding', ''];
const CCYS = ['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP', 'CHF', 'JPY'];
const INDEX = ['OMXS30', 'EURO STOXX 50', 'SX5E', 'S&P 500', 'DAX', 'FTSE 100', 'NASDAQ 100', 'NIKKEI 225', 'OMX'];
const mmyy = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]}${d.slice(2, 4)}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const mdy = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(2, 4)}`;
const cpnText = (c: number) => (chance(0.5) ? `${c}%` : chance(0.5) ? `${c}` : `${String(c).replace('.', ',')}%`);

interface Row {
  cls: RowClass;
  v: RowInput;
}

function makeRow(cls: RowClass): Row {
  const v: RowInput = {};
  const ccy = pick(CCYS);
  switch (cls) {
    case 'equity': {
      const co = company();
      v.security_name = pick([
        () => `${co} ${pick(SUFFIX)}`.trim(),
        () => `${co.toUpperCase()} ${pick(['B', 'A', 'SS', 'US', 'GY', 'FP', 'LN', ''])}`.trim(),
        () => `${co.slice(0, 4).toUpperCase()} ${pick(['B', 'A', 'US', 'SS'])}`,
        () => `${co} ${pick(['Reg', 'Pref', 'SDB', 'ADR', 'Class A'])}`,
        () => co,
      ])();
      v.isin = isin(pick(['SE', 'SE', 'US', 'DE', 'FR', 'GB', 'NO', 'FI', 'DK', 'CH', 'NL']));
      v.quantity = int(1, 400) * pick([1, 10, 50, 100]);
      v.price = round(pick([1 + rnd() * 40, 40 + rnd() * 400, 300 + rnd() * 3000]), 2);
      v.market_value_local = round(v.quantity * v.price);
      v.issuer_lei = chance(0.5) ? 'X' : undefined;
      break;
    }
    case 'gov_bond':
    case 'corporate_bond':
    case 'treasury_bill': {
      const tbill = cls === 'treasury_bill';
      const mat = addDays(tbill ? int(20, 360) : int(200, 30 * 365));
      const cpn = tbill ? 0 : pick([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.25, 2.5, 3, 3.125, 3.5, 4, 4.25, 4.75, 5, 6.5]);
      const frn = cls === 'corporate_bond' && chance(0.2);
      if (cls === 'gov_bond') {
        v.security_name = pick([
          () => `${pick(['SWEDEN', 'BUND', 'FRANCE OAT', 'UST', 'UKT', 'NORWAY', 'DENMARK', 'ITALY BTP', 'SPAIN'])} ${cpnText(cpn)} ${dmy(mat)}`,
          () => `${pick(['SGB', 'DBR', 'OBL', 'FRTR', 'T', 'UKT', 'NGB', 'DGB', 'BTPS', 'SPGB'])} ${cpn} ${mdy(mat)}`,
          () => `SGB ${int(1050, 1070)}`,
          () => `${pick(['Statsobligation', 'Bundesanleihe', "Obligation d'Etat", 'Government bond'])} ${int(1050, 1070)} ${mat.slice(0, 4)}`,
          () => `${pick(['Kingdom of Sweden', 'Republic of Finland', 'Federal Republic of Germany', 'United States Treasury'])} ${cpnText(cpn)} ${mat.slice(0, 4)}`,
        ])();
        v.isin = isin(pick(['SE', 'DE', 'FR', 'US', 'GB', 'NO', 'DK', 'IT', 'ES']));
      } else if (cls === 'treasury_bill') {
        v.security_name = pick([
          () => `SSV ${mat}`,
          () => `Statsskuldväxel ${mat}`,
          () => `${pick(['US T-BILL', 'T-Bill', 'BUBILL', 'German T-Bill', 'Swedish T-bill', 'BTF', 'UK TBILL'])} ${pick([dmy(mat), mdy(mat), mat])}`,
          () => `B 0 ${mdy(mat)}`,
          () => `${pick(['SE', 'DE', 'US'])} TREASURY BILL ${mmyy(mat)}`,
        ])();
        v.isin = isin(pick(['SE', 'DE', 'US', 'FR', 'GB']));
      } else {
        const iss = pick([() => company().toUpperCase(), () => `${company().toUpperCase()} ${pick(['AB', 'AB SER. B', 'AG', 'SA', 'ASA', 'OYJ', 'A/S', 'PLC', 'INC', 'NV'])}`, () => `${company()} ${pick(['AB', 'Group', 'Holding', 'Treasury', 'Finance'])}`])();
        v.security_name = pick([
          () => (frn ? `${iss} FRN ${mat.slice(0, 4)}` : `${iss} ${cpnText(cpn)} ${dmy(mat)}`),
          () => (frn ? `${iss} ${pick(['FRN', 'Float', 'FRN SNP'])} ${mdy(mat)}` : `${iss} ${cpn} ${mdy(mat)}`),
          () => `${iss} ${pick(['TREASURY', 'FINANCE', 'HYPOTEK', 'BANK', 'AB', 'AG'])} ${frn ? 'FRN' : cpnText(cpn)} ${mat.slice(0, 4)}`,
          () => `${iss} ${pick(['Covered', 'Säkerställd', 'Pfandbrief', 'Sub', 'Senior', 'SNP', 'Hybrid'])} ${cpnText(cpn)} ${mat.slice(0, 4)}`,
        ])();
        v.isin = isin(pick(['XS', 'XS', 'SE', 'DE', 'FR', 'US', 'NO', 'DK', 'FI']));
        if (frn) v.spread = round(0.3 + rnd() * 3, 2);
      }
      v.nominal = int(1, 200) * pick([1000, 10_000, 100_000]);
      v.price = round(tbill ? 97 + rnd() * 2.9 : 80 + rnd() * 35, pick([2, 3, 4]));
      v.market_value_local = round((v.nominal * v.price) / 100);
      v.coupon = frn ? undefined : cpn;
      v.maturity_date = mat;
      v.rating = pick(['AAA', 'AA+', 'AA', 'A', 'BBB+', 'BBB', 'BB']);
      v.yield = round(rnd() * 6, 3);
      v.modified_duration = round(tbill ? rnd() : rnd() * 15, 3);
      v.accrued_interest = cpn ? round((v.nominal * cpn) / 100 * rnd()) : undefined;
      v.issuer_lei = cls === 'corporate_bond' && chance(0.6) ? 'X' : undefined;
      break;
    }
    case 'fund': {
      const co = company();
      v.security_name = pick([
        () => `${co} ${pick(['Global Equity', 'Short Bond', 'Sverige', 'Europa Index', 'High Yield', 'Corporate Bond', 'Småbolag', 'Global Index', 'Ny Teknik', 'Räntefond Kort'])} ${pick(['A', 'B', 'I', 'C SEK', 'I EUR Acc', 'R', ''])}`.trim(),
        () => `${pick(['iShares', 'Xtrackers', 'Vanguard', 'Amundi', 'SPDR', 'Lyxor'])} ${pick(['Core MSCI World', 'S&P 500', 'FTSE All-World', 'Euro Stoxx 50', 'EUR Govt Bond', 'MSCI EM'])} UCITS ETF ${pick(['Acc', 'Dist', 'USD', ''])}`.trim(),
        () => `${co} ${pick(['Fund', 'Fond', 'Aktiefond', 'Räntefond', 'Sicav', 'Fonds'])} ${pick(['A', 'B', 'SEK', ''])}`.trim(),
        () => `${co} ${pick(['Sverige Plus', 'Global', 'Europa', 'Asia', 'Balanserad', 'Mix'])}`,
      ])();
      v.isin = isin(pick(['LU', 'LU', 'IE', 'IE', 'SE', 'FI', 'FR', 'DE']));
      v.quantity = round(10 + rnd() * 100_000, pick([0, 2, 3, 4]));
      v.price = round(5 + rnd() * 600, 4);
      v.market_value_local = round(v.quantity * v.price);
      break;
    }
    case 'cash': {
      v.security_name = pick([
        () => `${pick(['Cash', 'Likvida medel', 'Bank account', 'Kassa', 'Cash at bank', 'Liquidités', 'Bankguthaben', 'Margin account', 'Collateral', 'Konto'])} ${ccy}`,
        () => ccy,
        () => pick(['Cash', 'Likvida medel', 'Kassa', 'Bankkonto']),
      ])();
      const amount = round(int(-50, 5000) * 1000 + rnd() * 1000);
      v.quantity = chance(0.6) ? amount : undefined;
      v.price = chance(0.4) ? 1 : undefined;
      v.market_value_local = amount;
      break;
    }
    case 'forward': {
      const mat = addDays(int(5, 360));
      const other = pick(CCYS.filter((c) => c !== ccy));
      v.security_name = pick([
        () => `FX FWD ${ccy}/${other} ${pick([dmy(mat), mat, `${mat.slice(8, 10)}-${MON[Number(mat.slice(5, 7)) - 1]}-${mat.slice(0, 4)}`])}`,
        () => `${ccy}/${other} ${mat}`,
        () => `${ccy}${other} ${pick(['FWD', 'Fwd', 'Forward', 'Termin'])} ${mmyy(mat)}`,
        () => `${pick(['Sell', 'Buy'])} ${ccy} ${pick(['buy', 'sell'])} ${other} ${dmy(mat)}`,
        () => `${pick(['Valutatermin', 'Devisentermingeschäft', 'Change à terme', 'FX Forward'])} ${ccy}`,
      ])();
      v.quantity = int(1, 200) * pick([10_000, 100_000]) * (chance(0.4) ? -1 : 1);
      v.price = chance(0.3) ? round(pick([0.09, 1.1, 10.5, 11.6, 0.95]) * (0.95 + rnd() * 0.1), 4) : undefined;
      v.market_value_local = round((rnd() - 0.5) * Math.abs(v.quantity) * 0.04);
      v.maturity_date = mat;
      break;
    }
    case 'future': {
      const mat = addDays(int(10, 270));
      const idx = pick(INDEX);
      const bond = chance(0.3);
      const code = FUT_CODE[Number(mat.slice(5, 7)) - 1];
      v.security_name = bond
        ? pick([
            () => `${pick(['US 10YR NOTE', 'EURO-BUND', 'Euro Bobl', 'Long Gilt', 'SGB 10Y'])} ${pick(['FUT', 'Future', ''])} ${mmyy(mat)}`.replace(/ +/g, ' '),
            () => `${pick(['RX', 'OE', 'TY', 'G ', 'US'])}${code}${mat.slice(3, 4)}`,
          ])()
        : pick([
            () => `${idx} ${pick(['FUT', 'Future', 'Fut', 'Index Future', 'Terminskontrakt'])} ${mmyy(mat)}`,
            () => `${pick(['FESX', 'ES', 'NQ', 'FDAX', 'OMXS30', 'Z '])}${code}${mat.slice(3, 4)}`,
            () => `${idx} ${mat.slice(2, 4)}${mat.slice(5, 7)}`,
            () => `${pick(['Brent', 'WTI', 'Gold', 'Copper'])} ${pick(['FUT', 'Future'])} ${mmyy(mat)}`,
          ])();
      v.quantity = int(1, 60) * (chance(0.35) ? -1 : 1);
      v.price = bond ? round(110 + rnd() * 30, 3) : round(1500 + rnd() * 4000, 1);
      v.contract_size = bond ? 1000 : pick([1, 10, 50, 100]);
      v.market_value_local = chance(0.6) ? 0 : round((rnd() - 0.5) * 20_000);
      v.maturity_date = mat;
      v.delta = chance(0.5) ? 1 : undefined;
      v.underlying_name = bond ? undefined : idx;
      v.underlying_price = v.price;
      break;
    }
    case 'call_option':
    case 'put_option': {
      const put = cls === 'put_option';
      const mat = addDays(int(10, 700));
      const und = chance(0.5) ? pick(INDEX) : `${company().toUpperCase().slice(0, 4)} ${pick(['B', 'A', 'US', ''])}`.trim();
      const level = round(20 + rnd() * 4000, 1);
      const strike = Math.round(level * (0.8 + rnd() * 0.4));
      const C = put ? 'P' : 'C';
      v.security_name = pick([
        () => `${und} ${put ? 'Put' : 'Call'} ${strike} ${mmyy(mat)}`,
        () => `${und} ${strike}${C} ${mmyy(mat)}`,
        () => `${und} ${mat.slice(2, 4)}${'ABCDEFGHIJKL'[Number(mat.slice(5, 7)) - 1]} ${strike}`,
        () => `${und} ${mdy(mat)} ${C}${strike}`,
        () => `${put ? pick(['Säljoption', 'Verkaufsoption', 'Put option']) : pick(['Köpoption', 'Kaufoption', 'Call option'])} ${und}`,
        () => `${und} ${strike} ${mmyy(mat)}`,
      ])();
      v.quantity = int(1, 500) * (chance(0.3) ? -1 : 1);
      v.price = round(0.5 + rnd() * 80, 2);
      v.contract_size = pick([100, 100, 10, 1, 1000]);
      v.market_value_local = round(v.quantity * v.price * v.contract_size);
      v.strike = strike;
      v.call_put = put ? pick(['Put', 'P', 'Sälj']) : pick(['Call', 'C', 'Köp']);
      v.delta = round((0.05 + rnd() * 0.9) * (put ? -1 : 1), 3);
      v.underlying_name = und;
      v.underlying_price = level;
      v.maturity_date = mat;
      break;
    }
    case 'swap': {
      const mat = addDays(int(365, 30 * 365));
      const yrs = Math.round((Date.parse(mat) - Date.parse(VALUATION)) / (365 * 864e5));
      v.security_name = pick([
        () => `${ccy} ${yrs}Y ${pick(['PAYER', 'RECEIVER', 'Payer', 'Rec'])} IRS`,
        () => `IRS ${ccy} ${yrs}Y ${pick(['PAY', 'REC'])}`,
        () => `${pick(['Interest rate swap', 'Ränteswap', 'Zinsswap', 'Swap de taux'])} ${mat.slice(0, 4)}`,
        () => `${pick(['CCS', 'Cross currency swap'])} ${ccy}/${pick(CCYS.filter((c) => c !== ccy))} ${mat.slice(0, 4)}`,
        () => `${pick(['TRS', 'Total return swap'])} ${pick(INDEX)} ${mmyy(mat)}`,
        () => `${ccy} ${pick(['3M STIBOR', '6M EURIBOR', 'SOFR', 'OIS'])} ${yrs}Y ${pick(['SWAP', 'Swap', ''])}`.trim(),
      ])();
      v.quantity = int(1, 50) * 1_000_000 * (chance(0.3) ? -1 : 1);
      v.market_value_local = round((rnd() - 0.5) * Math.abs(v.quantity) * 0.06);
      v.maturity_date = mat;
      break;
    }
  }
  return { cls, v };
}

/** Which columns a table has: files differ, and the model must work with whatever is there. */
function layout(): (keyof RowInput)[] {
  const cols: (keyof RowInput)[] = ['market_value_local'];
  if (chance(0.95)) cols.push('security_name');
  if (chance(0.75)) cols.push('isin');
  if (chance(0.35)) cols.push('other_identifier');
  if (chance(0.9)) cols.push('quantity');
  if (chance(0.45)) cols.push('nominal');
  if (chance(0.8)) cols.push('price');
  if (chance(0.45)) cols.push('coupon');
  if (chance(0.5)) cols.push('maturity_date');
  const deriv = chance(0.35);
  for (const k of ['contract_size', 'strike', 'call_put', 'delta', 'underlying_name', 'underlying_price'] as const) if (chance(deriv ? 0.7 : 0.08)) cols.push(k);
  for (const k of ['rating', 'yield', 'modified_duration', 'accrued_interest', 'spread', 'issuer_lei'] as const) if (chance(0.25)) cols.push(k);
  return cols;
}

const WEIGHTS: [RowClass, number][] = [
  ['equity', 3], ['gov_bond', 1.5], ['corporate_bond', 2], ['treasury_bill', 0.8], ['fund', 1.5], ['cash', 1], ['forward', 1], ['future', 1], ['call_option', 1], ['put_option', 1], ['swap', 0.8],
];
const totalW = WEIGHTS.reduce((a, [, w]) => a + w, 0);
const drawClass = (): RowClass => {
  let x = rnd() * totalW;
  for (const [c, w] of WEIGHTS) if ((x -= w) < 0) return c;
  return 'equity';
};

console.log(JSON.stringify({ featureNames: ROW_FEATURE_NAMES, classes: ROW_CLASSES }));
for (let t = 0; t < Number(tablesArg); t++) {
  const cols = new Set(layout());
  // Mixed amount columns: one "quantity" column for every row, nominal included.
  const mixed = !cols.has('nominal') || chance(0.3);
  for (let i = 0, n = int(8, 30); i < n; i++) {
    const { cls, v } = makeRow(drawClass());
    if (mixed && v.nominal !== undefined) {
      v.quantity = v.nominal;
      delete v.nominal;
    }
    const kept: RowInput = {};
    for (const k of Object.keys(v) as (keyof RowInput)[]) if (cols.has(k) && v[k] !== undefined && !(chance(0.05) && k !== 'market_value_local')) (kept as Record<string, unknown>)[k] = v[k];
    console.log(JSON.stringify({ x: rowFeatures(kept, VALUATION), label: cls, table: t }));
  }
}
