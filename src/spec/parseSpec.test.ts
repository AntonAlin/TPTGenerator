import { describe, expect, it } from 'vitest';
import { inferDataType, normalizeRequirement, parseCodeList, parseSpec, type Grid } from './parseSpec.ts';
import { spec } from './index.ts';

const g = (rows: (string | [string, boolean])[][]): Grid =>
  rows.map((r) => r.map((c) => (Array.isArray(c) ? { text: c[0], highlighted: c[1] } : { text: c, highlighted: false })));

describe('normalizeRequirement', () => {
  it.each([
    ['M', 'mandatory'],
    ['C', 'conditional'],
    ['x', 'conditional'],
    ['O', 'optional'],
    ['I', 'indicative'],
    ['N/A', 'not_applicable'],
    ['"N/A"', 'not_applicable'],
    ['?', 'unknown'],
  ])('%s → %s', (raw, expected) => expect(normalizeRequirement(raw)).toBe(expected));
});

describe('parseCodeList', () => {
  it('parses dash/equals lines including multi-char codes', () => {
    expect(parseCodeList('closed list:\n1 - ISIN\n99 - Undertaking')).toEqual([
      { code: '1', label: 'ISIN' },
      { code: '99', label: 'Undertaking' },
    ]);
    expect(parseCodeList('0 = non-listed\n1 = EEA')?.map((e) => e.code)).toEqual(['0', '1']);
    expect(parseCodeList('3L - Listed\n3X – Unlisted')?.map((e) => e.code)).toEqual(['3L', '3X']);
  });
  it('parses quoted "x refers to" lines', () => {
    expect(parseCodeList('alpha (1)\n"a" refers to A\n"e1" refers to B')?.map((e) => e.code)).toEqual(['a', 'e1']);
  });
  it('parses inline pairs and quoted token lists', () => {
    expect(parseCodeList('Alpha(2) ("C" = Covered / "NC" = Non Covered)')).toEqual([
      { code: 'C', label: 'Covered' },
      { code: 'NC', label: 'Non Covered' },
    ]);
    expect(parseCodeList('"Fixed" or "Floating"')?.map((e) => e.code)).toEqual(['Fixed', 'Floating']);
  });
  it('joins wrapped labels', () => {
    const list = parseCodeList('4 – adjusted equity methods (applicable for the valuation of\nparticipations)\n5 – other');
    expect(list?.[0].label).toBe('adjusted equity methods (applicable for the valuation of participations)');
  });
  it('does not treat a single line or version numbers as a list', () => {
    expect(parseCodeList('Alphanum (max 255)')).toBeUndefined();
    expect(parseCodeList('V7.0 (official) dated x\nV8.0 (official) dated y')).toBeUndefined();
  });
});

describe('inferDataType', () => {
  it.each([
    ['6_Valuation_date', 'YYYY-MM-DD ISO 8601', 'date'],
    ['4_Portfolio_currency', 'Code ISO 4217', 'currency'],
    ['52_Issuer_country', 'Code ISO 3166-1 alpha 2', 'country'],
    ['12_CIC_code', 'CIC code - Alphanumeric (4)', 'cic'],
    ['47_Issuer_identification_code', 'Alphanumeric (max 20)', 'string'],
    ['5_NAV', 'number with floating decimal', 'number'],
    ['148_Economic_sector_NACE', 'Latest version of NACE codification in force', 'nace'],
    ['1000_TPT_Version', 'V7.0 (official) dated 25 November 2024', 'string'],
    ['112_Credit_rating', '', 'unknown'],
  ])('%s', (header, cod, expected) => expect(inferDataType(header, cod, '').dataType).toBe(expected));

  it('uses a closed list in the comment only when the codification is a bare size descriptor', () => {
    expect(inferDataType('59_CQS', 'num (1)', 'closed list :\n0. step 0\n1. step 1').dataType).toBe('code');
    expect(inferDataType('68_Id', 'Depends on identification type', 'closed list:\n1. ISIN\n2. other').dataType).toBe('string');
  });

  it('extracts max length', () => {
    expect(inferDataType('3_Name', 'Alphanum (max 255)', '').maxLength).toBe(255);
  });
});

describe('parseSpec on a synthetic grid', () => {
  const grid = g([
    ['Tripartite Template (TPT) for SII Asset Data reporting - V9'],
    ['Version 9.0 dated 01/01/30'],
    ['NUM_DATA', 'FundsXML XPath', 'DEFINITION', 'CODIFICATION', 'COMMENT', 'Mandatory / Conditional', 'Other (CIC 0)', 'Futures\n(CIC A)', 'SST'],
    ['Section one'],
    ['1_Portfolio_identifying_data', '/x', 'Id', 'Alphanum', '', 'M', 'x', 'x', 'M'],
    [['2b_Something_new', true], '', 'Def', '0 - a\n1 - b', '', 'C', '', 'x', ''],
    ['Section two'],
    ['17b_Old', '', 'Old', '', '', 'N/A', '', '', ''],
    ['1000_TPT_Version', '', 'Version', 'V9.0 (official) dated 1 January 2030', '', 'M', 'x', 'x', ''],
  ]);
  const parsed = parseSpec({ grid, sourceFile: 't.xlsx', sourceSha256: 'abc' });

  it('reads metadata, sections and fields in order', () => {
    expect(parsed.meta.version).toBe('V9.0');
    expect(parsed.meta.versionFieldValue).toBe('V9.0 (official) dated 1 January 2030');
    expect(parsed.sections).toEqual(['Section one', 'Section two']);
    expect(parsed.fields.map((f) => f.id)).toEqual(['1', '2b', '17b', '1000']);
    expect(parsed.fields.map((f) => f.order)).toEqual([0, 1, 2, 3]);
  });
  it('captures CIC applicability, regimes, highlights and N/A', () => {
    const [f1, f2, f3] = parsed.fields;
    expect(f1.cicApplicability).toEqual({ '0': 'x', A: 'x' });
    expect(f1.otherRegimes).toEqual({ SST: 'M' });
    expect(f2.changedFromPreviousVersion).toBe(true);
    expect(f2.codeList?.map((c) => c.code)).toEqual(['0', '1']);
    expect(f3.mustBeEmpty).toBe(true);
    expect(f2.section).toBe('Section one');
    expect(f3.section).toBe('Section two');
  });
  it('applies overrides and cross-checks them', () => {
    const p = parseSpec({
      grid,
      sourceFile: 't',
      sourceSha256: 'x',
      overrides: { versionFieldValue: 'V9.0 dated 1 January 2030', mustBeEmptyFieldIds: ['1', '999'] },
    });
    expect(p.meta.versionFieldValue).toBe('V9.0 dated 1 January 2030');
    expect(p.fields[0].mustBeEmpty).toBe(true);
    expect(p.warnings.some((w) => w.includes('999'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('Field 1 is listed'))).toBe(true);
  });
  it('fails loudly without a header row', () => {
    expect(() => parseSpec({ grid: g([['nothing']]), sourceFile: '', sourceSha256: '' })).toThrow(/NUM_DATA/);
  });
});

describe('generated spec (active template)', () => {
  it('has unique ids and the version field last', () => {
    const ids = spec.fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('1000');
    expect(ids[0]).toBe('1');
  });
  it('field numbers never decrease in export order', () => {
    for (let i = 1; i < spec.fields.length; i++) {
      expect(spec.fields[i].number).toBeGreaterThanOrEqual(spec.fields[i - 1].number);
    }
  });
  it('every field has a requirement level and CIC 0–F columns were read', () => {
    expect(spec.fields.every((f) => f.requirement !== 'unknown')).toBe(true);
    expect(Object.keys(spec.fields[0].cicApplicability).length).toBe(16);
  });
  it('the supplementary must-be-empty list agrees with the template', () => {
    expect(spec.warnings.filter((w) => w.includes('must-be-empty'))).toEqual([]);
  });
});
