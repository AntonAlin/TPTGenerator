/**
 * Generate the synthetic sample holdings files in /samples.
 * All data is fictional (identifiers are random with valid check digits,
 * except a few well-known public equity ISINs). Run: npx tsx scripts/make-samples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';

const out = resolve(import.meta.dirname, '../samples');
mkdirSync(out, { recursive: true });

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

const writeXlsx = (wb: XLSX.WorkBook, path: string) =>
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);

const d = (s: string) => new Date(`${s}T00:00:00Z`);

/** ISO 17442 LEI with valid check digits from an 18-character base. */
function lei(base: string): string {
  const digits = [...`${base}00`].map((c) => parseInt(c, 36).toString()).join('');
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  return base + String(98 - rem).padStart(2, '0');
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// 1. Swedish custodian export (xlsx): title rows, two-row merged header, sections, subtotals, totals, notes column, footer.
{
  const rows: unknown[][] = [
    ['Innehavsrapport', null, null, null, null, null, null, null, null, null],
    ['Fond: Exempelfonden', null, null, null, null, null, null, null, null, null],
    ['Per: 2026-09-30', null, null, null, null, null, null, null, null, null],
    [],
    [null, null, null, null, null, null, 'Marknadsvärde', null, null, null],
    ['ISIN', 'Värdepapper', 'Antal', 'Valuta', 'Kurs', 'Förfallodag', 'Lokal', 'SEK', 'Andel %', 'Kommentar'],
    ['Aktier'],
    ['SE0000108656', 'Ericsson B', 120000, 'SEK', 85.42, null, 10250400, 10250400, 20.4, null],
    ['SE0000115446', 'Volvo B', 40000, 'SEK', 271.8, null, 10872000, 10872000, 21.64, null],
    ['US0378331005', 'Apple Inc', 3000, 'USD', 228.5, null, 685500, 7129200, 14.19, 'Kontrollera kurs'],
    ['Summa aktier', null, null, null, null, null, null, 28251600, 56.23, null],
    ['Obligationer'],
    [isin('SE', '000123457'), 'SWEDEN 0.75% 12/11/2029', 10000000, 'SEK', 94.125, d('2029-11-12'), 9412500, 9412500, 18.73, null],
    [isin('SE', '001987654'), 'EXEMPEL BANK AB FRN 2027', 5000000, 'SEK', 100.35, d('2027-03-15'), 5017500, 5017500, 9.99, null],
    [isin('DE', '000110148'), 'BUND 2.5% 15/02/2035', 400000, 'EUR', 98.9, d('2035-02-15'), 395600, 4549400, 9.06, 'Pantsatt'],
    ['Summa obligationer', null, null, null, null, null, null, 18979400, 37.78, null],
    ['Likvida medel'],
    [null, 'Likvida medel SEK', 3010000, 'SEK', 1, null, 3010000, 3010000, 5.99, null],
    ['Totalt', null, null, null, null, null, null, 50241000, 100, null],
    [],
    ['* Kurser per stängning 2026-09-30. Källa: förvaringsinstitut.'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws['!merges'] = [{ s: { r: 4, c: 6 }, e: { r: 4, c: 7 } }];
  for (let r = 12; r <= 14; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: 5 });
    if (ws[ref]) ws[ref].z = 'yyyy-mm-dd';
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Innehav');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Rapport skapad', '2026-10-01']]), 'Info');
  writeXlsx(wb, `${out}/se_custodian_holdings.xlsx`);
}

// 2. English bond portfolio (csv, comma, quoted thousands, text dates, blank rows, totals).
{
  const lines = [
    'Bond Portfolio Holdings,,,,,,,,',
    'As of 30-Sep-2026,,,,,,,,',
    ',,,,,,,,',
    'ISIN,Security Description,Par Value,Clean Price,CCY,Coupon,Maturity,Market Value (Local),Accrued Interest',
    `${isin('US', '91282CJX9')},UST 4 1/8 15-NOV-32,"1,000,000",98.4375,USD,4.125,15-Nov-2032,"984,375.00","15,682.07"`,
    `${isin('XS', '204914400')},REPUBLIC OF ITALY 3.85% 01/09/2049,"500,000",86.20,EUR,3.85,01-Sep-2049,"431,000.00","1,550.68"`,
    `${isin('XS', '231245678')},EXAMPLE CORP 5.25% 2031,"750,000",101.15,USD,5.25,15-Mar-2031,"758,625.00","2,153.91"`,
    ',,,,,,,,',
    `${isin('FR', '001400H74')},FRANCE OAT 3% 25/05/2033,"300,000",99.87,EUR,3,25-May-2033,"299,610.00","3,197.26"`,
    'Total,,,,,,,"2,473,610.00","22,583.92"',
  ];
  writeFileSync(`${out}/en_bond_portfolio.csv`, `${lines.join('\r\n')}\r\n`);
}

// 3. Swedish fund admin export (csv, semicolon, decimal comma, Windows-1252, unlabelled total row).
{
  const lines = [
    'Fondkod;Namn;ISIN-kod;Antal;Valuta;Marknadsvärde;Marknadsvärde SEK;Andel av fondförmögenhet',
    `EXF1;Ericsson B;SE0000108656;12 000;SEK;1 025 040,00;1 025 040,00;3,24%`,
    `EXF1;Microsoft Corp;US5949181045;2 500;USD;1 062 500,00;11 050 000,00;34,94%`,
    `EXF1;BAE Systems plc;GB0002634946;80 000;GBP;1 400 000,00;18 340 000,00;58,00%`,
    `EXF1;Exempel Räntefond A;${isin('SE', '005432109')};1 234,5678;SEK;158 222,21;158 222,21;0,50%`,
    `EXF1;Kassa SEK;;1 050 000,00;SEK;1 050 000,00;1 050 000,00;3,32%`,
    `;;;;;;31 623 262,21;100,00%`,
  ];
  const text = `${lines.join('\r\n')}\r\n`;
  // Encode as Windows-1252 (Latin-1 subset covers å, ä, ö).
  const bytes = Uint8Array.from([...text].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63)));
  writeFileSync(`${out}/se_fund_admin_semicolon.csv`, bytes);
}

// 4. German depot statement (xlsx): headers on row 3, repeated header (page break), Stückzinsen, Fälligkeit as text.
{
  const header = ['ISIN', 'Wertpapierbezeichnung', 'Nominale/Stück', 'Währung', 'Kurs', 'Kurswert in EUR', 'Stückzinsen', 'Fälligkeit', 'Land'];
  const rows: unknown[][] = [
    ['Depotauszug Musterfonds', null],
    ['Stichtag 30.09.2026', null],
    header,
    [isin('DE', '000103043'), 'Bundesrep. Deutschland 1,7% 15.08.2032', 2000000, 'EUR', 96.15, 1923000, 15095.89, '15.08.2032', 'DE'],
    [isin('DE', '000A3MQS5'), 'Muster AG Anleihe 4,25% 2030', 500000, 'EUR', 102.3, 511500, 4483.56, '01.12.2030', 'DE'],
    ['DE0007164600', 'SAP SE Inhaber-Aktien', 3000, 'EUR', 245.1, 735300, null, null, 'DE'],
    header,
    ['LU' + '0000000000'.slice(0, 0) + isin('LU', '123456789').slice(2), 'Muster Rentenfonds I', 15000.5, 'EUR', 52.37, 785581.19, null, null, 'LU'],
    ['Summe', null, null, null, null, 3955381.19, 19579.45, null, null],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Depot');
  writeXlsx(wb, `${out}/de_depot_statement.xlsx`);
}

// 5. Minimal export without useful headers (values-only detection).
{
  const rows: unknown[][] = [
    ['Col1', 'Col2', 'Col3', 'Col4', 'Col5'],
    ['SE0000108656', 'Ericsson B', 'SEK', 1000, 85420],
    ['US0378331005', 'Apple Inc', 'USD', 50, 118823.5],
    ['SE0000115446', 'Volvo B', 'SEK', 300, 81540],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  writeXlsx(wb, `${out}/generic_headers.xlsx`);
}

// 6. French portfolio (csv, UTF-8 with BOM, semicolon, decimal comma, narrow no-break space thousands, comment column).
{
  const fr = (n: number, dec = 2) => n.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const oat = { nominal: 1_000_000, price: 101.25 };
  const rows = [
    { isin: isin('FR', '000120271'), name: 'TOTALENERGIES SE', qty: 15_000, price: 58.42, ccy: 'EUR', note: '' },
    { isin: isin('FR', '000131104'), name: 'BNP PARIBAS ACT.A', qty: 9_000, price: 64.1, ccy: 'EUR', note: 'Dividende à recevoir' },
    { isin: isin('FR', '001400AB1'), name: 'FRANCE OAT 2,75% 25/02/2029', qty: oat.nominal, price: oat.price, ccy: 'EUR', note: '', bond: true, accrued: 16_650.68, maturity: '25/02/2029' },
    { isin: isin('FR', '001234567'), name: 'EXEMPLE MONETAIRE COURT TERME I', qty: 120.5, price: 10_512.34, ccy: 'EUR', note: '' },
    { isin: '', name: 'LIQUIDITES EUR', qty: 250_000, price: 1, ccy: 'EUR', note: '' },
  ].map((r) => ({ ...r, mv: round2(r.bond ? (r.qty * r.price) / 100 : r.qty * r.price) }));
  const total = round2(rows.reduce((a, r) => a + r.mv, 0));
  const lines = [
    'Portefeuille : Fonds Exemple Actions-Obligations;;;;;;;;;',
    'Date de valorisation : 30/09/2026;;;;;;;;;',
    ';;;;;;;;;',
    'Code ISIN;Libellé;Quantité;Cours;Devise;Valorisation (EUR);Poids (%);Coupon couru;Échéance;Commentaire',
    ...rows.map((r) =>
      [r.isin, r.name, fr(r.qty, Number.isInteger(r.qty) ? 0 : 2), fr(r.price, r.bond ? 3 : 2), r.ccy, fr(r.mv), fr((r.mv / total) * 100), r.accrued ? fr(r.accrued) : '', r.maturity ?? '', r.note].join(';'),
    ),
    ';;;;;;;;;',
    `Total portefeuille;;;;;${fr(total)};${fr(100)};;;`,
  ];
  writeFileSync(`${out}/fr_portefeuille.csv`, `\ufeff${lines.join('\r\n')}\r\n`);
}

// 7. English multi-asset fund in legacy .xls (BIFF8): derivatives, ETF, covered bond, CIC and LEI columns,
//    weights as fractions, asset-class subtotals, two cash currencies. Base currency EUR, USD at 1.1.
{
  const usd = 1 / 1.1;
  type R = [string, string, string, string, string, string, number, number | null, number, number | null, string, string];
  const pos: R[] = [
    ['Equities', isin('DE', '000716460'), 'SAP SE', 'SAP SE', lei('529900D6BF99LW9R2E'), 'EUR', 4_000, 245.1, 980_400, null, '', ''],
    ['Equities', isin('US', '594918104'), 'MICROSOFT CORP', 'Microsoft Corporation', lei('INR2EJN1ERAN0W5ZP9'), 'USD', 2_500, 425, 1_062_500, null, '', ''],
    ['Funds', isin('IE', '00B4L5Y98'), 'EXAMPLE MSCI WORLD UCITS ETF USD ACC', 'Example ETF plc', lei('549300EXAMPLEETF001'.slice(0, 18)), 'USD', 30_000, 102.35, 3_070_500, null, '', ''],
    ['Bonds', isin('XS', '231245678'), 'NORDIC MORTGAGE BANK COVERED 1.25% 15/06/2031', 'Nordic Mortgage Bank Oyj', lei('743700NORDICMB0001'), 'EUR', 2_000_000, 92.4, 1_848_000, null, 'XL27', 'AAA'],
    ['Bonds', isin('IT', '000512345'), 'BTP 3.5% 01/03/2030', 'Republic of Italy', '', 'EUR', 1_500_000, 101.8, 1_527_000, null, '', 'BBB'],
    ['Bonds', isin('DE', '000A3E5AB'), 'MUSTER INDUSTRIE AG 4.25% 01/12/2030', 'Muster Industrie AG', lei('529900MUSTERIND001'), 'EUR', 800_000, 102.3, 818_400, null, 'DE21', 'BBB-'],
    ['Derivatives', 'FWD-0001', 'FX FWD EUR/USD 15-DEC-2026', 'Example Bank AG', lei('529900EXAMPLEBANK1'), 'USD', 5_000_000, null, 12_345.67, null, '', ''],
    ['Derivatives', 'FUT-ESZ6', 'EURO STOXX 50 FUT DEC26', 'Eurex Clearing AG', lei('529900LN3S50JPU47S06'.slice(0, 18)), 'EUR', 10, 4_950, 0, null, '', ''],
    ['Cash', '', 'CASH EUR', 'Depositary Bank SA', '', 'EUR', 412_000, 1, 412_000, null, '', ''],
    ['Cash', '', 'CASH USD', 'Depositary Bank SA', '', 'USD', 150_000, 1, 150_000, null, '', ''],
  ];
  for (const p of pos) p[9] = round2(p[5] === 'USD' ? p[8] * usd : p[8]);
  const totalBase = round2(pos.reduce((a, p) => a + (p[9] as number), 0));
  const header = ['Asset Class', 'Security ID', 'Description', 'Issuer', 'Issuer LEI', 'CCY', 'Quantity/Nominal', 'Price', 'MV Local', 'MV Base (EUR)', 'Weight', 'CIC', 'Rating'];
  const rows: unknown[][] = [['Multi-asset fund - positions as of 30 Sep 2026'], [], header];
  for (const cls of ['Equities', 'Funds', 'Bonds', 'Derivatives', 'Cash']) {
    const group = pos.filter((p) => p[0] === cls);
    for (const p of group) rows.push([p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], Math.round(((p[9] as number) / totalBase) * 1e6) / 1e6, p[10], p[11]]);
    const sub = round2(group.reduce((a, p) => a + (p[9] as number), 0));
    rows.push([`Sub-total ${cls}`, null, null, null, null, null, null, null, null, sub, Math.round((sub / totalBase) * 1e6) / 1e6, null, null]);
  }
  rows.push(['Total', null, null, null, null, null, null, null, null, totalBase, 1, null, null]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Positions');
  writeFileSync(`${out}/en_multi_asset.xls`, XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer);
}

// 8. English custodian export with a mixed "Holding" column (shares, nominal, fund units, notional,
//    contracts, cash) and an FX forward whose notional is repeated in both market value columns.
//    The total row adds up only without the forward. Base currency EUR, 1 USD = 1/1.1 EUR.
{
  const usd = 1 / 1.1;
  type P = { name: string; id: string; holding: number; price: number | null; ccy: string; mv: number; bond?: boolean };
  const pos: P[] = [
    { name: 'SAP SE', id: isin('DE', '000716460'), holding: 4_000, price: 245.1, ccy: 'EUR', mv: 0 },
    { name: 'MICROSOFT CORP', id: isin('US', '594918104'), holding: 2_500, price: 425, ccy: 'USD', mv: 0 },
    { name: 'BUND 2.5% 15/02/2035', id: isin('DE', '000110148'), holding: 1_000_000, price: 98.9, ccy: 'EUR', mv: 0, bond: true },
    { name: 'UST 4 1/8 15-NOV-32', id: isin('US', '91282CJX9'), holding: 500_000, price: 98.4375, ccy: 'USD', mv: 0, bond: true },
    { name: 'EXAMPLE EURO LIQUIDITY FUND I', id: isin('LU', '765432109'), holding: 1_234.5678, price: 101.23, ccy: 'EUR', mv: 0 },
    { name: 'EURO STOXX 50 FUT DEC26', id: 'FUT-ESZ6', holding: 10, price: 4_950, ccy: 'EUR', mv: 0 },
    { name: 'CASH EUR', id: '', holding: 250_000, price: null, ccy: 'EUR', mv: 250_000 },
  ];
  for (const p of pos) if (p.price !== null) p.mv = p.name.includes('FUT') ? 0 : round2(p.bond ? (p.holding * p.price) / 100 : p.holding * p.price);
  const base = (p: P) => round2(p.ccy === 'USD' ? p.mv * usd : p.mv);
  const fwd = { name: 'FX FWD EUR/USD 15-DEC-2026', id: 'FWD-0001', notional: 2_000_000 };
  const rows: unknown[][] = [
    ['Custodian positions 30/09/2026'],
    [],
    ['Security', 'ISIN', 'Holding', 'Price', 'CCY', 'Market value', 'Market value (EUR)'],
    ...pos.slice(0, 5).map((p) => [p.name, p.id, p.holding, p.price, p.ccy, p.mv, base(p)]),
    // The custodian shows the forward's notional where the market value should be.
    [fwd.name, fwd.id, fwd.notional, null, 'USD', fwd.notional, round2(fwd.notional * usd)],
    ...pos.slice(5).map((p) => [p.name, p.id || null, p.holding, p.price, p.ccy, p.mv, base(p)]),
    ['Total', null, null, null, null, null, round2(pos.reduce((a, p) => a + base(p), 0))],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Positions');
  writeXlsx(wb, `${out}/en_custodian_mixed_amounts.xlsx`);
}

// 9. Swedish export with one "Nominellt/Marknadsvärde" column: nominal for bonds, market value for
//    everything else, and a weight column (the only way to tell which is which).
{
  const sv = (n: number, d = 2) => n.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/\u2212/g, '-');
  const pos = [
    { name: 'Ericsson B', id: 'SE0000108656', amount: 855_000, price: 85.42, value: 855_000 },
    { name: 'Volvo B', id: 'SE0000115446', amount: 1_087_200, price: 271.8, value: 1_087_200 },
    { name: 'SWEDEN 0.75% 12/11/2029', id: isin('SE', '000123457'), amount: 5_000_000, price: 94.125, value: 4_706_250 },
    { name: 'STADSHYPOTEK 1.5% 2028-03-01', id: isin('SE', '000777888'), amount: 3_000_000, price: 98.2, value: 2_946_000 },
    { name: 'Likvida medel SEK', id: '', amount: 406_000, price: 1, value: 406_000 },
  ];
  const total = pos.reduce((a, p) => a + p.value, 0);
  const lines = [
    'Värdepapper;ISIN-kod;Nominellt/Marknadsvärde;Kurs;Valuta;Andel %',
    ...pos.map((p) => [p.name, p.id, sv(p.amount), sv(p.price, 3), 'SEK', sv((p.value / total) * 100, 4)].join(';')),
  ];
  writeFileSync(`${out}/sv_nominellt_eller_varde.csv`, `${lines.join('\r\n')}\r\n`);
}

console.log(`Samples written to ${out}`);
