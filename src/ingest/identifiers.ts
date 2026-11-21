/**
 * Validators for financial identifiers.
 */

/** Convert letters to numbers as in ISO 6166 / ISO 17442 (A=10 … Z=35). */
function expandAlnum(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57) out += ch;
    else if (c >= 65 && c <= 90) out += String(c - 55);
    else return '';
  }
  return out;
}

/** ISO 6166 ISIN: 2-letter prefix, 9 alphanumerics, Luhn check digit over the expanded digits. */
export function isValidIsin(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  const digits = expandAlnum(s.slice(0, 11));
  let sum = 0;
  let double = true; // rightmost digit of the payload is doubled
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10 === Number(s[11]);
}

/** True if the text has ISIN shape (without checking the check digit). */
export function looksLikeIsin(raw: unknown): boolean {
  return typeof raw === 'string' && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(raw.trim().toUpperCase());
}

/** Compute mod 97 of a long decimal string. */
function mod97(digits: string): number {
  let rem = 0;
  for (let i = 0; i < digits.length; i += 7) rem = Number(String(rem) + digits.slice(i, i + 7)) % 97;
  return rem;
}

/** ISO 17442 LEI: 18 alphanumerics + 2 check digits, valid when the expanded number mod 97 == 1 (ISO 7064). */
export function isValidLei(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(s)) return false;
  const digits = expandAlnum(s);
  return digits !== '' && mod97(digits) === 1;
}

/** CUSIP: 8 alphanumerics + check digit (modulus 10 "double-add-double"). */
export function isValidCusip(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toUpperCase();
  if (!/^[0-9A-Z*@#]{8}[0-9]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const ch = s[i];
    let v: number;
    if (/[0-9]/.test(ch)) v = Number(ch);
    else if (/[A-Z]/.test(ch)) v = ch.charCodeAt(0) - 55;
    else v = ch === '*' ? 36 : ch === '@' ? 37 : 38;
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(s[8]);
}

/** SEDOL: 6 alphanumerics (no vowels) + weighted check digit. */
export function isValidSedol(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toUpperCase();
  if (!/^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}[0-9]$/.test(s)) return false;
  const w = [1, 3, 1, 7, 3, 9];
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const ch = s[i];
    sum += (/[0-9]/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 55) * w[i];
  }
  return (10 - (sum % 10)) % 10 === Number(s[6]);
}
