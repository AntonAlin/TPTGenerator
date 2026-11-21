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

console.log(`Samples written to ${out}`);
