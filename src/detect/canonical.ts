/**
 * Canonical internal fields that input columns are mapped to.
 * These are the app's own vocabulary (not TPT fields); later phases map them
 * to TPT fields via the spec.
 */
export const CANONICAL_FIELDS = [
  'isin',
  'other_identifier',
  'security_name',
  'quantity',
  'nominal',
  'market_value_local',
  'market_value_portfolio',
  'price',
  'currency',
  'coupon',
  'maturity_date',
  'asset_type',
  'weight',
  'rating',
  'issuer_name',
  'issuer_lei',
  'country',
  'accrued_interest',
  'fx_rate',
  'cic',
  'amount_mixed',
  'ignore',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export const CANONICAL_INFO: Record<CanonicalField, { label: string; help: string }> = {
  isin: { label: 'ISIN', help: 'ISO 6166 instrument identifier (12 characters).' },
  other_identifier: { label: 'Other identifier', help: 'Ticker, SEDOL, CUSIP, Bloomberg or internal security id.' },
  security_name: { label: 'Security name', help: 'Instrument description, e.g. "SWEDEN 0.75% 12/11/2029".' },
  quantity: { label: 'Quantity / units', help: 'Number of shares, units or contracts held.' },
  nominal: { label: 'Nominal amount', help: 'Face value held for debt instruments.' },
  market_value_local: { label: 'Market value (quotation currency)', help: 'Value in the instrument’s own currency.' },
  market_value_portfolio: { label: 'Market value (portfolio currency)', help: 'Value in the fund / share class currency.' },
  price: { label: 'Price', help: 'Unit price or price in % of nominal.' },
  currency: { label: 'Currency', help: 'ISO 4217 quotation currency of the instrument.' },
  coupon: { label: 'Coupon rate', help: 'Annual coupon in %.' },
  maturity_date: { label: 'Maturity date', help: 'Final redemption date.' },
  asset_type: { label: 'Asset type / class', help: 'Instrument type or asset class text from the source system.' },
  weight: { label: 'Weight', help: 'Share of the portfolio (sums to ~100% or ~1).' },
  rating: { label: 'Credit rating', help: 'Rating such as AA+, Baa1.' },
  issuer_name: { label: 'Issuer name', help: 'Name of the issuing entity.' },
  issuer_lei: { label: 'Issuer LEI', help: 'ISO 17442 Legal Entity Identifier of the issuer.' },
  country: { label: 'Country', help: 'ISO 3166 country code (issuer or listing).' },
  accrued_interest: { label: 'Accrued interest', help: 'Accrued coupon amount.' },
  fx_rate: { label: 'FX rate', help: 'Exchange rate between quotation and portfolio currency.' },
  cic: { label: 'CIC code', help: 'Solvency II Complementary Identification Code (4 characters).' },
  amount_mixed: {
    label: 'Amount (mixed: units / nominal / notional / value)',
    help: 'One column that holds different things per row, e.g. shares for equities, nominal for bonds, notional for forwards and the amount for cash. Each cell is sorted into the right field using the other columns.',
  },
  ignore: { label: '— Ignore this column —', help: 'Not used for the TPT.' },
};

/** Fields at most one column may be mapped to. */
export const UNIQUE_FIELDS: ReadonlySet<CanonicalField> = new Set(CANONICAL_FIELDS.filter((f) => f !== 'ignore'));
