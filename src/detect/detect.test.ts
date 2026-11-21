import { describe, expect, it } from 'vitest';
import { headerSimilarity, matchHeader, normalizeHeader } from './headerMatch.ts';
import { classifyColumns, LOW_CONFIDENCE, model, predictProba } from './classify.ts';
import { FEATURE_NAMES } from './features.ts';
import type { ColumnInput } from './features.ts';

describe('header matching', () => {
  it('normalises accents, case and punctuation', () => {
    expect(normalizeHeader('Marknadsvärde (SEK)')).toBe('marknadsvarde sek');
    expect(normalizeHeader('Fälligkeit_Datum')).toBe('falligkeit datum');
    expect(normalizeHeader('Weight %')).toBe('weight %');
  });
  it('scores exact, contained and typo variants', () => {
    expect(headerSimilarity('isin', 'isin')).toBe(1);
    expect(headerSimilarity('market value sek', 'market value')).toBeGreaterThan(0.85);
    expect(headerSimilarity('maturty date', 'maturity date')).toBeGreaterThan(0.8);
    expect(headerSimilarity('isin', 'currency')).toBeLessThan(0.3);
  });
  it.each([
    ['Innehav', 'security_name'],
    ['Antal', 'quantity'],
    ['Marknadsvärde', 'market_value_local'],
    ['Valuta', 'currency'],
    ['Kurs', 'price'],
    ['Förfallodag', 'maturity_date'],
    ['Kupong', 'coupon'],
    ['Stückzinsen', 'accrued_interest'],
    ['Échéance', 'maturity_date'],
    ['Devise', 'currency'],
  ])('%s → %s', (h, field) => {
    const m = matchHeader(h);
    const best = Object.entries(m).sort((a, b) => b[1].score - a[1].score)[0];
    expect(best[0]).toBe(field);
  });
});

describe('model', () => {
  it('matches the feature set and produces probabilities', () => {
    expect(model.featureNames).toEqual(FEATURE_NAMES);
    const p = predictProba(FEATURE_NAMES.map(() => 0));
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

const fieldsOf = (cols: ColumnInput[], fixed?: Parameters<typeof classifyColumns>[1]) =>
  Object.fromEntries(classifyColumns(cols, fixed).map((p) => [p.header, p.field]));

describe('classifyColumns', () => {
  it('maps a Swedish holdings table with decimal commas', () => {
    const cols: ColumnInput[] = [
      { header: 'ISIN-kod', values: ['SE0000108656', 'US0378331005', 'SE0004869071', 'SE0000115446'] },
      { header: 'Värdepapper', values: ['Ericsson B', 'Apple Inc', 'SGB 1047 1,25% 12/05/2032', 'Volvo B'] },
      { header: 'Antal/Nominellt', values: ['1 000', '200', '5 000 000', '300'] },
      { header: 'Kurs', values: ['85,50', '190,25', '98,125', '250,10'] },
      { header: 'Valuta', values: ['SEK', 'USD', 'SEK', 'SEK'] },
      { header: 'Marknadsvärde SEK', values: ['85 500,00', '396 120,00', '4 906 250,00', '75 030,00'] },
      { header: 'Andel %', values: ['1,56', '7,21', '89,30', '1,37'] },
      { header: 'Förfallodag', values: [null, null, '2032-05-12', null] },
      { header: 'Kommentar', values: [null, 'Kontrollera kurs', null, null] },
    ];
    const f = fieldsOf(cols);
    expect(f['ISIN-kod']).toBe('isin');
    expect(f['Värdepapper']).toBe('security_name');
    expect(f['Antal/Nominellt']).toBe('amount_mixed');
    expect(f['Kurs']).toBe('price');
    expect(f['Valuta']).toBe('currency');
    expect(f['Marknadsvärde SEK']).toBe('market_value_portfolio');
    expect(f['Andel %']).toBe('weight');
    expect(f['Förfallodag']).toBe('maturity_date');
    expect(f['Kommentar']).toBe('ignore');
  });

  it('uses values when headers are missing', () => {
    const cols: ColumnInput[] = [
      { header: 'Column 1', values: ['SE0000108656', 'US0378331005', 'SE0000115446'] },
      { header: 'Column 2', values: ['SEK', 'USD', 'SEK'] },
      { header: 'Column 3', values: ['HWUPKR0MPOU8FGXBT394', '549300GKFG0RYRRQ1414', '7LTWFZYICNSX8D621K86'] },
    ];
    const f = fieldsOf(cols);
    expect(f['Column 1']).toBe('isin');
    expect(f['Column 2']).toBe('currency');
    expect(f['Column 3']).toBe('issuer_lei');
  });

  it('maps an English bond file and distinguishes local vs base market value', () => {
    const cols: ColumnInput[] = [
      { header: 'Security Description', values: ['UST 4 1/8 15-NOV-32', 'BUND 0 02/15/31', 'XYZ AB FRN 2027'] },
      { header: 'Par Value', values: [1000000, 2000000, 500000] },
      { header: 'Clean Price', values: [98.5, 87.25, 100.1] },
      { header: 'CCY', values: ['USD', 'EUR', 'SEK'] },
      { header: 'Market Value (Local)', values: [985000, 1745000, 500500] },
      { header: 'Market Value (Base EUR)', values: [905000, 1745000, 44700] },
      { header: 'Coupon', values: [4.125, 0, 3.2] },
      { header: 'Maturity', values: [new Date('2032-11-15'), new Date('2031-02-15'), new Date('2027-06-01')] },
      { header: 'Accrued Interest', values: [1200.5, 0, 300.25] },
    ];
    const f = fieldsOf(cols);
    expect(f['Security Description']).toBe('security_name');
    expect(f['Par Value']).toBe('nominal');
    expect(f['Clean Price']).toBe('price');
    expect(f['CCY']).toBe('currency');
    expect(f['Market Value (Local)']).toBe('market_value_local');
    expect(f['Market Value (Base EUR)']).toBe('market_value_portfolio');
    expect(f['Coupon']).toBe('coupon');
    expect(f['Maturity']).toBe('maturity_date');
    expect(f['Accrued Interest']).toBe('accrued_interest');
  });

  it('never assigns a unique field twice and honours pinned mappings', () => {
    const cols: ColumnInput[] = [
      { header: 'ISIN', values: ['SE0000108656', 'US0378331005'] },
      { header: 'ISIN 2', values: ['SE0000108656', 'US0378331005'] },
    ];
    const preds = classifyColumns(cols);
    expect(preds.filter((p) => p.field === 'isin')).toHaveLength(1);
    const pinned = classifyColumns(cols, new Map([[1, { field: 'isin' as const, source: 'user' as const }]]));
    expect(pinned[1].field).toBe('isin');
    expect(pinned[1].source).toBe('user');
    expect(pinned[0].field).not.toBe('isin');
  });

  it('gives reasons and flags low confidence', () => {
    const preds = classifyColumns([
      { header: 'ISIN', values: ['SE0000108656', 'US0378331005'] },
      { header: 'x', values: ['a', 'b'] },
    ]);
    expect(preds[0].reasons.join(' ')).toMatch(/valid ISINs/);
    expect(preds[0].confidence).toBeGreaterThan(LOW_CONFIDENCE);
  });

  it('leaves a column ignored rather than giving it a leftover field at a tiny probability', () => {
    const n = 12;
    const cols: ColumnInput[] = [
      { header: 'Name', values: Array.from({ length: n }, (_, i) => `Company ${i} AB`) },
      { header: 'Quantity', values: Array.from({ length: n }, (_, i) => 1000 + i * 37) },
      { header: 'Price', values: Array.from({ length: n }, (_, i) => 50 + i) },
      { header: 'Market value', values: Array.from({ length: n }, (_, i) => (1000 + i * 37) * (50 + i)) },
      { header: 'Sell currency', values: Array.from({ length: n }, (_, i) => (i % 2 ? 'USD' : 'EUR')) },
      { header: 'Buy amount', values: Array.from({ length: n }, (_, i) => 1e6 + i * 1000) },
    ];
    const preds = classifyColumns(cols);
    for (const p of preds.filter((x) => x.field !== 'ignore')) expect(p.confidence, p.header).toBeGreaterThanOrEqual(0.1);
    expect(preds.find((p) => p.header === 'Buy amount')!.field).not.toBe('market_value_local');
  });
  it('lets the header decide for a near-empty column (a market value override with only zeros)', () => {
    const n = 30;
    const cols: ColumnInput[] = [
      { header: 'Name', values: Array.from({ length: n }, (_, i) => `Company ${i} AB`) },
      { header: 'Quantity', values: Array.from({ length: n }, (_, i) => 1000 + i * 37) },
      { header: 'Price', values: Array.from({ length: n }, (_, i) => 50 + i) },
      { header: 'Market value override', values: Array.from({ length: n }, (_, i) => (i < 2 ? 0 : null)) },
    ];
    const p = classifyColumns(cols).find((x) => x.header === 'Market value override')!;
    expect(p.field).toBe('market_value_local');
    expect(p.confidence).toBeLessThan(LOW_CONFIDENCE);
    expect(p.reasons[0]).toMatch(/header decides/);
  });
});
