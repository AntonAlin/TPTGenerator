import { describe, expect, it } from 'vitest';
import { isValidCusip, isValidIsin, isValidLei, isValidSedol, looksLikeIsin } from './identifiers.ts';

describe('ISIN', () => {
  it.each(['US0378331005', 'US5949181045', 'GB0002634946', 'SE0000108656', 'se0000115446', ' SE0000115446 '])('valid %s', (s) =>
    expect(isValidIsin(s)).toBe(true));
  it.each(['US0378331006', 'XS2049144001', 'US037833100', '1234567890AB', '', 'SEK'])('invalid %s', (s) =>
    expect(isValidIsin(s)).toBe(false));
  it('shape check ignores the check digit', () => expect(looksLikeIsin('US0378331006')).toBe(true));
  it('rejects non-strings', () => expect(isValidIsin(12345)).toBe(false));
});

describe('LEI', () => {
  it.each(['HWUPKR0MPOU8FGXBT394', '549300GKFG0RYRRQ1414', '7LTWFZYICNSX8D621K86'])('valid %s', (s) =>
    expect(isValidLei(s)).toBe(true));
  it.each(['HWUPKR0MPOU8FGXBT395', 'HWUPKR0MPOU8FGXBT39', 'US0378331005'])('invalid %s', (s) =>
    expect(isValidLei(s)).toBe(false));
});

describe('CUSIP and SEDOL', () => {
  it('CUSIP', () => {
    expect(isValidCusip('037833100')).toBe(true);
    expect(isValidCusip('037833101')).toBe(false);
  });
  it('SEDOL', () => {
    expect(isValidSedol('0263494')).toBe(true);
    expect(isValidSedol('0263495')).toBe(false);
  });
});
