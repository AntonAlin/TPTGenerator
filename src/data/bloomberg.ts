/**
 * Bloomberg tickers: the exchange code a ticker carries ("ASML NA Equity" → Euronext Amsterdam)
 * gives the country where the security is listed, which is what CIC positions 1–2 ask for; a
 * country column is often the country of risk or domicile instead (Spotify: risk SE, domicile LU,
 * listed in the US). Only well-established exchange codes are listed; an unknown one says nothing.
 */
const EXCHANGE_COUNTRY: Record<string, string> = {
  NA: 'NL', GY: 'DE', GR: 'DE', FP: 'FR', SS: 'SE', LN: 'GB', SW: 'CH', NO: 'NO', FH: 'FI', DC: 'DK', AV: 'AT', SM: 'ES', IM: 'IT',
  BB: 'BE', PL: 'PT', ID: 'IE', LX: 'LU', PW: 'PL', US: 'US', UN: 'US', UW: 'US', UQ: 'US', CN: 'CA', CT: 'CA', JT: 'JP', JP: 'JP', HK: 'HK', AU: 'AU',
};

/** A Bloomberg ticker with a yellow key ("… Equity", "… Index") or an exchange code ("ERICB SS"). */
export const BLOOMBERG_RE = /^\S+(?:\s+\S+)*\s+(Equity|Index|Comdty|Curncy|Corp|Govt|Mtge|Muni|Pfd|M-Mkt)$|^[A-Z0-9][A-Z0-9./-]{0,11}\s+[A-Z]{2}$/;

export function isBloombergTicker(s: string | undefined): boolean {
  return !!s && BLOOMBERG_RE.test(s.trim());
}

/** The listing country of a share's Bloomberg ticker ("SPOT US Equity" → US), if its exchange code is known. */
export function listingFromBloomberg(ticker: string | undefined): { country: string; code: string } | undefined {
  const m = ticker ? /^([A-Z0-9][A-Z0-9./-]{0,11})\s+([A-Z]{2})(?:\s+Equity)?$/i.exec(ticker.trim()) : null;
  if (!m) return undefined;
  const code = m[2].toUpperCase();
  const country = EXCHANGE_COUNTRY[code];
  return country ? { country, code } : undefined;
}
