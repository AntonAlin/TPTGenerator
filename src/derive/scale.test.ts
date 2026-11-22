import { describe, expect, it } from 'vitest';
import { decideScale, metadataScale, minorUnit, scaleFromRows, scaleHint } from './scale.ts';
import { detectTable } from '../ingest/table.ts';
import { normalizeHoldings } from './holdings.ts';
import { interpretAmounts } from './amounts.ts';
import type { CanonicalField } from '../detect/canonical.ts';

describe('scale hints', () => {
  it.each([
    ['Marknadsvärde (TSEK)', 1000],
    ['Market Value USD (000s)', 1000],
    ["Value ('000)", 1000],
    ['Kurswert in Tsd. EUR', 1000],
    ['Valeur en milliers d’euros', 1000],
    ['MV kEUR', 1000],
    ['Marknadsvärde MSEK', 1e6],
    ['Value (USD millions)', 1e6],
    ['Marknadsvärde SEK', undefined],
    ['Market value', undefined],
    ['Tesla Inc', undefined],
  ])('%s → %s', (h, f) => expect(scaleHint(h)).toBe(f));

  it('reads the scale from a title line about amounts, not from a fund name', () => {
    expect(metadataScale(detectTable([['Innehav'], ['Belopp i tusental kronor'], ['Namn', 'Antal', 'Värde'], ['A', 1, 2], ['B', 3, 4]]))?.factor).toBe(1000);
    expect(metadataScale(detectTable([['Million Dollar Fund'], ['Namn', 'Antal', 'Värde'], ['A', 1, 2], ['B', 3, 4]]))).toBeUndefined();
  });

  it('minor currency units', () => {
    expect([minorUnit('GBp'), minorUnit('GBX'), minorUnit('gbx'), minorUnit('ZAc'), minorUnit('GBP'), minorUnit('SEK')]).toEqual(['GBP', 'GBP', 'GBP', 'ZAR', undefined, undefined]);
  });
});

describe('the rows decide', () => {
  const thousands = [
    { q: 100, price: 250, value: 25 }, // 25,000 shown as 25
    { q: 1_000_000, price: 98.5, value: 985 }, // bond: 985,000 shown as 985
    { q: 40, price: 1000, value: 40 },
  ];
  it('finds a scale nobody wrote down', () => {
    expect(scaleFromRows(thousands)).toMatchObject({ factor: 1000, agree: 3, checked: 3 });
    expect(decideScale('Value', undefined, thousands)?.factor).toBe(1000);
  });
  it('overrules a hint the rows contradict, and keeps one they cannot check', () => {
    const units = thousands.map((r) => ({ ...r, value: r.value * 1000 }));
    expect(decideScale('Value (TSEK)', { factor: 1000, source: 'header' }, units)).toBeUndefined();
    expect(decideScale('Value (TSEK)', { factor: 1000, source: 'header' }, [])?.factor).toBe(1000);
  });
});

describe('reading a file in thousands, and prices in pence', () => {
  it('multiplies the value columns and the total by 1000 and says why', () => {
    const t = detectTable([
      ['Innehav per 2026-09-30'],
      ['Värdepapper', 'Antal', 'Kurs', 'Valuta', 'Marknadsvärde (TSEK)'],
      ['Volvo B', 1000, 262, 'SEK', 262],
      ['Ericsson B', 5000, 85, 'SEK', 425],
      ['SEB A', 2000, 150, 'SEK', 300],
      ['Summa', null, null, null, 987],
    ]);
    const mapping: CanonicalField[] = ['security_name', 'quantity', 'price', 'currency', 'market_value_portfolio'];
    const n = normalizeHoldings(t, mapping);
    expect(n.holdings.map((h) => h.file.market_value_portfolio)).toEqual([262_000, 425_000, 300_000]);
    expect(n.holdings[0].amountCells?.[1].scaled).toMatch(/TSEK.*thousand.*confirms/);
    expect(n.totals[0].cells[4]).toBe(987_000);
    expect(n.notes.join(' ')).toMatch(/multiplied by 1,000/);
  });
  it('divides pence prices by 100 and reports the pound', () => {
    const t = detectTable([
      ['Stock', 'Holding', 'Price', 'Currency', 'Value'],
      ['Shell plc', 1000, 2650, 'GBX', 26500],
      ['BP plc', 2000, 480, 'GBp', 9600],
      ['Apple Inc', 10, 230, 'USD', 2300],
    ]);
    const n = normalizeHoldings(t, ['security_name', 'quantity', 'price', 'currency', 'market_value_local']);
    expect(n.holdings.map((h) => [h.file.currency, h.file.price])).toEqual([['GBP', 26.5], ['GBP', 4.8], ['USD', 230]]);
    expect(n.holdings[0].scaled?.price).toMatch(/GBX.*divided by 100/);
  });
});

describe('a derivative notional repeated in the value columns', () => {
  it('is read once as the notional and the copies are dropped, without a total row', () => {
    const t = detectTable([
      ['Name', 'Holding', 'Market value USD', 'Market value EUR'],
      ['FX FWD EUR/USD 15-DEC-2026', 2_000_000, 2_000_000, 1_818_181.82],
      ['SAP SE', 4000, 980_400, 891_272.73],
    ]);
    const n = normalizeHoldings(t, ['security_name', 'amount_mixed', 'market_value_local', 'market_value_portfolio']);
    n.holdings[0].file.currency = 'USD';
    n.holdings[1].file.currency = 'USD';
    n.holdings[1].file.price = 245.1;
    const r = interpretAmounts(n.holdings, { portfolioCurrency: 'EUR', fx: (c) => (c === 'USD' ? 1 / 1.1 : 1) });
    expect(r.interpretations[0]!.cells.map((c) => c.role)).toEqual(['nominal', 'other', 'other']);
    expect(r.interpretations[0]!.evidence.join(' ')).toMatch(/repeats the notional/);
  });
});
