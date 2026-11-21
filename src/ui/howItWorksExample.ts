/**
 * The worked example on the "How it works" page. It is not a mock-up: the page runs this small
 * custodian-style sheet through the same functions the app uses for an uploaded file (table
 * detection, column classification, normalisation, amount interpretation) and shows what they
 * decide. A unit test pins the outcome, so the page's text cannot drift from the code.
 */
import type { RawCell } from '../ingest/readFile.ts';
import { detectTable } from '../ingest/table.ts';
import { classifyColumns } from '../detect/classify.ts';
import { normalizeHoldings } from '../derive/holdings.ts';
import { guessPortfolioCurrency, impliedFxRates } from '../derive/valuation.ts';
import { interpretAmounts } from '../derive/amounts.ts';
import { columnsOf } from './session.ts';

/** USD/SEK used in the example's "Marknadsvärde SEK" column. */
const USD_SEK = 9.51;
/** The forward's real market value in SEK: in the total, but not shown on its row. */
const FORWARD_REAL_MV_SEK = -12_400;

const rows = (): RawCell[][] => {
  const holdings: RawCell[][] = [
    ['Aktier'],
    ['Ericsson B', 'SE0000108656', 1_000, 85.42, 'SEK', 85_420, 85_420],
    ['Microsoft Corp', 'US5949181045', 200, 425.1, 'USD', 85_020, 808_540.2],
    ['Obligationer'],
    ['SWEDEN 0.75% 12/11/2029', 'SE0011281922', 10_000_000, 94.125, 'SEK', 9_412_500, 9_412_500],
    ['Derivat'],
    // The custodian prints the forward's notional in both value columns.
    ['FX FWD SEK/USD 15-DEC-2026', null, 5_000_000, null, 'USD', 5_000_000, 5_000_000 * USD_SEK],
    ['Likvida medel'],
    ['Likvida medel SEK', null, 3_010_000, null, 'SEK', 3_010_000, 3_010_000],
  ];
  const total = 85_420 + 808_540.2 + 9_412_500 + FORWARD_REAL_MV_SEK + 3_010_000;
  return [
    ['Innehavsrapport Exempelfonden'],
    ['Per 2026-09-30'],
    [],
    ['Värdepapper', 'ISIN-kod', 'Antal/Nominellt', 'Kurs', 'Valuta', 'Marknadsvärde lokal', 'Marknadsvärde SEK'],
    ...holdings,
    ['Totalt', null, null, null, null, null, Math.round(total * 100) / 100],
  ];
};

export function runExample() {
  const sheet = rows();
  const table = detectTable(sheet);
  const predictions = classifyColumns(columnsOf(table));
  const mapping = predictions.map((p) => p.field);
  const norm = normalizeHoldings(table, mapping);
  const implied = impliedFxRates(norm.holdings);
  const base = guessPortfolioCurrency(norm.holdings, norm.portfolioValueHeader).currency ?? 'SEK';
  const fx = (c: string) => (c === base ? 1 : implied[c]?.rate);
  const amounts = interpretAmounts(norm.holdings, { portfolioCurrency: base, fx, totals: table.totals });
  return { sheet, table, predictions, base, amounts };
}

export type Example = ReturnType<typeof runExample>;
